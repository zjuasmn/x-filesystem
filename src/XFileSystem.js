import {basename, dirname, normalize as _normalize, resolve} from "path";
import FSWatcher from "./FSWatcher";
import {FILE, FILEMODE, DIRECTORY, DIRMODE, pathToArray, isDir, isFile} from "./utils";
const errors = require("errno");
const node_modules = 'node_modules';
let normalize = (_path) => resolve('/', _normalize(_path));

class XFileSystemError extends Error {
  constructor(err, path) {
    super();
    Error.captureStackTrace && Error.captureStackTrace(this, this.constructor);
    this.code = err.code;
    this.errno = err.errno;
    this.message = err.description;
    this.path = path;
  }
}

function exists(item) {
  return item != undefined;
}

const trueFn = () => true;
const falseFn = () => false;

function isReservePath(abspath) {
  return abspath == '/' || abspath == `/${node_modules}`;
}
function NotImplemented() {
  throw new XFileSystemError(errors.code.ENOSYS);
}

export function inLib(path) {
  return normalize(path).indexOf(node_modules) == 1;
}

export function needToFetchRemote(e, abspath) {
  if (e.code != errors.code.ENOENT.code) {
    return false;
  } else if (!inLib(abspath)) {
    return false;
  } else if (/\/package\.json$/.test(abspath) && pathToArray(abspath).length > 3) {
    return false
  } else {
    return true;
  }
}
const libPrefixLength = node_modules.length + 1;

export default class XFileSystem {
  data = {'': {birthtime: new Date(), type: DIRECTORY, _time: new Date()}};
  _watcher = {};
  _fetch;
  
  constructor(fetch) {
    this._fetch = fetch;
    this.mkdirSync(node_modules);
  }
  
  _meta(abspath) {
    const path = pathToArray(abspath);
    let current = this.data;
    for (let token of path) {
      if (!isDir(current))
        return;
      current = current[token];
    }
    return current;
  }
  
  _syncToCb = (fn) => {
    let fs = this;
    return function () {
      let path = arguments[0];
      let args = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
      let callback = arguments[arguments.length - 1];
      if (typeof path != 'string') {
        setImmediate(() => callback(new TypeError('path must be a string')));
        return
      }
      if (typeof callback != 'function') {
        args.push(callback);
        callback = falseFn;
      }
      let result;
      try {
        result = fs[fn + "Sync"](path, ...args);
      } catch (e) {
        setImmediate(() => callback(e));
        return;
      }
      setImmediate(() => callback(null, result));
    }
  };
  
  _remote = (fn, _shouldBeDir) => {
    let fs = this;
    return function () {
      let path = arguments[0];
      let args = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
      let callback = arguments[arguments.length - 1];
      if (!path || !(typeof path == 'string')) {
        throw new TypeError('path must be a string');
      }
      if (typeof callback != 'function') {
        args.push(callback);
        callback = falseFn;
      }
      let abspath = normalize(path);
      let result;
      try {
        result = fs[fn + 'Sync'](abspath, ...args);
      } catch (e) {
        if (!needToFetchRemote(e, abspath)) {
          setImmediate(() => callback(e));
          return;
        }
        let shouldBeDir = _shouldBeDir;
        let fetchPath = abspath.substr(libPrefixLength); // /node_modules/XX/YY => /XX/YY
        let dirpath = abspath;
        
        if (shouldBeDir === false) {
          if (fetchPath.substr(1).indexOf('/') < 0) { // top level module, like `/jquery`
            setImmediate(() => callback(new XFileSystemError(errors.code.EISDIR, abspath)));
            return;
          }
        } else if (shouldBeDir === undefined) {
          shouldBeDir = true;
          if (fetchPath.substr(1).indexOf('/') >= 0) { // top level module, like `/jquery`
            // in module, like `/jquery/dist/sub`,
            fetchPath = dirname(fetchPath); //fetch upperlevel, like `/jquery/dist
            dirpath = dirname(abspath);
          }
        }
        
        fs._fetch(fetchPath, shouldBeDir)
          .then((textOrArray) => {
            if (shouldBeDir) {
              let dir = fs.mkdirpSync(dirpath);
              for (let sub of textOrArray) {
                if (sub[sub.length - 1] == '/') { // dir
                  sub = sub.substr(0, sub.length - 1);
                  if (dir[sub]) {
                    if (!isDir(dir[sub])) {
                      return callback(new XFileSystemError(errors.code.EEXIST, dirpath + '/' + sub))
                    }
                  } else {
                    this._write(dir, dirpath + '/' + sub, {}, DIRECTORY);
                  }
                } else { // remote file
                  this._write(dir, dirpath + '/' + sub, null, FILE);
                }
              }
            } else {
              fs.writeFileSync(abspath, textOrArray);
            }
            try {
              result = fs[fn + 'Sync'](abspath, ...args)
            } catch (e) {
              callback(e);
              return;
            }
            callback(null, result);
          })
          .catch((e2) => callback(e));
        return;
      }
      setImmediate(() => callback(null, result));
    }
  };
  
  _emit(abspath, dirpath, filename, type) {
    this._watcher[dirpath] && this._watcher[dirpath].emit('watch', type, filename);
    this._watcher[abspath] && this._watcher[abspath].emit('watch', type, filename);
  }
  
  /**
   *
   * @param current parent content
   * @param abspath target abspath
   * @param content content to be written
   * @param type FILE or DIRECTORY
   * @returns {*} written content
   * @private
   */
  _write(current, abspath, content, type) {
    let dirpath = dirname(abspath);
    let filename = basename(abspath);
    let createNew = false;
    
    if (type == DIRECTORY) {
      current[filename] = content;
    } else if (type == FILE) {
      if (current[filename]) {
        current[filename].buffer = content;
      } else {
        current[filename] = {buffer: content};
      }
    } else {
      throw new XFileSystemError(errors.code.UNKNOWN);
    }
    let ret = current[filename];
    if (!ret['']) {
      createNew = true;
      ret[''] = {birthtime: new Date(), type};
    }
    ret['']._time = new Date();
    this._emit(abspath, dirpath, filename, createNew ? 'rename' : 'change');
    return ret;
  }
  
  _remove(_path, testFn) {
    let abspath = normalize(_path);
    
    if (isReservePath(abspath)) {
      throw new XFileSystemError(errors.code.EPERM, abspath);
    }
    let dirpath = dirname(abspath);
    let dir = this._meta(dirpath);
    let filename = basename(abspath);
    if (!isDir(dir) || !(filename in dir) || !testFn(dir[filename])) {
      throw new XFileSystemError(errors.code.ENOENT, abspath);
    }
    let ret = dir[filename];
    delete dir[filename];
    this._emit(abspath, dirpath, filename, 'rename');
    return ret;
  }
  
  access = this._syncToCb('access');
  accessSync = NotImplemented;
  appendFile = this._syncToCb('appendFile');
  appendFileSync = NotImplemented;
  chmod = this._syncToCb('chmod');
  chmodSync = NotImplemented;
  chown = this._syncToCb('chown');
  chownSync = NotImplemented;
  close = this._syncToCb('close');
  closeSync = NotImplemented;
  
  get constants() {
    NotImplemented();
  }
  
  createReadStream = NotImplemented;
  createWriteStream = NotImplemented;
  exists = NotImplemented;
  existsSync = (p) => exists(this._meta(p));
  fchmod = this._syncToCb('fchmod');
  fchmodSync = NotImplemented;
  fchown = this._syncToCb('fchown');
  fchownSync = NotImplemented;
  fdatasync = this._syncToCb('fdatasync');
  fdatasyncSync = NotImplemented;
  fstat = this._syncToCb('fstat');
  fstatSync = NotImplemented;
  fsync = this._syncToCb('fsync');
  fsyncSync = NotImplemented;
  ftruncate = this._syncToCb('ftruncate');
  ftruncateSync = NotImplemented;
  futimes = this._syncToCb('futimes');
  futimesSync = NotImplemented;
  lchmod = this._syncToCb('lchmod');
  lchmodSync = NotImplemented;
  lchown = this._syncToCb('lchown');
  lchownSync = NotImplemented;
  link = this._syncToCb('link');
  linkSync = NotImplemented;
  lstat = this._remote('lstat');
  
  lstatSync(path) {
    const abspath = normalize(path);
    let current = this._meta(abspath);
    if (!current) {
      throw new XFileSystemError(errors.code.ENOENT, abspath);
    }
    let stat = current[''];
    let _time = stat._time;
    return {
      isBlockDevice: falseFn,
      isCharacterDevice: falseFn,
      isSymbolicLink: falseFn,
      isFIFO: falseFn,
      isSocket: falseFn,
      atime: _time,
      mtime: _time,
      ctime: _time,
      mode: stat.type == FILE ? FILEMODE : DIRMODE,
      isDirectory: stat.type == DIRECTORY ? trueFn : falseFn,
      isFile: stat.type == FILE ? trueFn : falseFn,
      birthtime: stat.birthtime,
    }
  };
  
  mkdir = this._syncToCb('mkdir');
  
  mkdirSync(_path) {
    const abspath = normalize(_path);
    const path = pathToArray(abspath);
    if (path.length === 0) {
      throw new XFileSystemError(errors.code.EEXIST, abspath);
    }
    let current = this.data;
    let i;
    for (i = 0; i < path.length - 1; i++) {
      if (!isDir(current[path[i]]))
        throw new XFileSystemError(errors.code.ENOENT, abspath);
      current = current[path[i]];
    }
    if (isDir(current[path[i]])) {
      throw new XFileSystemError(errors.code.EEXIST, abspath);
    } else if (isFile(current[path[i]])) {
      throw new XFileSystemError(errors.code.ENOTDIR, abspath);
    }
    this._write(current, abspath, {}, DIRECTORY);
  }
  
  mkdirp = this._syncToCb('mkdirp');
  
  mkdirpSync(_path) {
    const abspath = normalize(_path);
    const path = pathToArray(abspath);
    let current = this.data;
    let currentPath = '/';
    for (let token of path) {
      if (currentPath != '/') {
        currentPath += '/';
      }
      currentPath += token;
      if (isFile(current[token])) {
        throw new XFileSystemError(errors.code.ENOTDIR, abspath);
      } else if (isDir(current[token])) {
        current = current[token];
      } else {
        current = this._write(current, currentPath, {}, DIRECTORY);
      }
    }
    return current;
  }
  
  mkdtemp = this._syncToCb('mkdtemp');
  mkdtempSync = NotImplemented;
  open = this._syncToCb('open');
  openSync = NotImplemented;
  read = this._syncToCb('read');
  readdir = this._remote('readdir', true);
  
  readdirSync(path) {
    let abspath = normalize(path);
    let current = this._meta(abspath);
    if (!isDir(current)) {
      throw new XFileSystemError(errors.code[isFile(current) ? 'ENOTDIR' : 'ENOENT'], abspath);
    }
    return Object.keys(current).filter(Boolean);
  };
  
  readFile = this._remote('readFile', false);
  
  readFileSync(_path, options) {
    let encoding = typeof options == 'object' ? options.encoding : options;
    const abspath = normalize(_path);
    let current = this._meta(abspath);
    if (!isFile(current) || !current.buffer) {
      throw new XFileSystemError(errors.code[isDir(current) ? 'EISDIR' : 'ENOENT'], abspath);
    }
    return encoding ? current.buffer.toString(encoding) : current.buffer;
  }
  
  readlink = this._syncToCb('readlink');
  readlinkSync = NotImplemented;
  readSync = NotImplemented;
  realpath = this._syncToCb('realpath');
  realpathSync = normalize;
  rename = this._syncToCb('rename');
  
  renameSync(oldPath, newPath) {
    let absOldPath = normalize(oldPath);
    let absNewPath = normalize(newPath);
    if (isReservePath(absOldPath)) {
      throw new XFileSystemError(errors.code.EPERM, absOldPath);
    }
    if (isReservePath(absNewPath)) {
      throw new XFileSystemError(errors.code.EPERM, absNewPath);
    }
    let dir = this._meta(dirname(absNewPath));
    if (!dir) {
      throw new XFileSystemError(errors.code.ENOENT, absNewPath);
    }
    let content = this._remove(absOldPath, () => true);
    this._write(dir, absNewPath, isFile(content) ? content.buffer : content, content[''].type);
  }
  
  rmdir = this._syncToCb('rmdir');
  rmdirSync = (path) => this._remove(path, isDir);
  stat = this._remote('stat');
  statSync = this.lstatSync;
  symlink = this._syncToCb('symlink');
  symlinkSync = NotImplemented;
  truncate = this._syncToCb('truncate');
  truncateSync = NotImplemented;
  unlink = this._syncToCb('unlink');
  unlinkSync = (path) => this._remove(path, isFile);
  unwatchFile = NotImplemented;
  utimes = this._syncToCb('utimes');
  utimesSync = NotImplemented;
  
  watch(filename, options, listener) {
    options = options || {};
    if (typeof options === 'function') {
      listener = options;
      options = {};
    } else if (typeof options === 'string') {
      options = {encoding: options};
    }
    if (typeof options !== 'object')
      throw new TypeError('"options" must be a string or an object');
    
    const watcher = new FSWatcher(this);
    watcher.start(normalize(filename), options.encoding);
    if (listener) {
      watcher.addListener('change', listener);
    }
    return watcher;
  }
  
  watchFile = this.watch;
  write = NotImplemented;
  writeFile = this._syncToCb('writeFile');
  
  writeFileSync(_path, content, options) {
    let abspath = normalize(_path);
    let encoding = typeof options == 'object' ? options.encoding : options;
    let dirpath = dirname(abspath);
    let filename = basename(abspath);
    let current = this.mkdirpSync(dirpath);
    if (!filename || isDir(current[filename])) {
      throw new XFileSystemError(errors.code.EISDIR, abspath);
    }
    this._write(current, abspath, encoding || typeof content === "string" ? new Buffer(content, encoding) : content, FILE)
  }
  
  writeSync = NotImplemented;
  
  _toPlainObject(current) {
    if (isFile(current)) {
      return current.buffer && current.buffer.toString();
    } else if (isDir(current)) {
      let o = {};
      for (let filename in current) {
        if (filename) {
          o[filename] = this._toPlainObject(current[filename]);
        }
      }
      return o;
    } else {
      throw new XFileSystemError(errors.code.UNKNOWN);
    }
    
  }
  
  toString() {
    return JSON.stringify(this._toPlainObject(this.data));
  }
  
  _build(abspath, o) {
    if (o == null || typeof o == 'string') {
      this.writeFileSync(abspath, o && new Buffer(o));
    } else {
      if (!isReservePath(abspath)) {
        this.mkdirSync(abspath);
      }
      for (let filename in o) {
        this._build(resolve(abspath, filename), o[filename]);
      }
    }
  }
  
  parse(o) {
    this._build('/', o);
  }
}

XFileSystem.FSWatch = FSWatcher;
XFileSystem.ReadStream = NotImplemented;
XFileSystem.WriteStream = NotImplemented;
