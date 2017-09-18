const fs = require('fs')
const fse = require('fs-extra')
const path = require('path')
const name = require('./package.json').name
const DEFAULT_SEP = '/'
const FILTER_OUT_DIR = ['.idea', '.vscode', '.gitignore', 'node_modules']
const DEFAULT_OPTION = {
  src: resolve('src'),
  dist: resolve('src'),
  resolve: ['html'],
  urlCb (input) { return input}
}

// 1. gather html file
// 2. gather production file
// 3. upload all production file
// 4. find the usage of production file in html file
// 5. if found, replace

function resolve (...input) {
  return path.resolve(...input)
}

function normalize (input, sep = DEFAULT_SEP) {
  const _input = path.normalize(input)
  return _input.split(path.sep).join(sep)
}

function join (...inputs) {
  return normalize(path.join(...inputs))
}

function isFilterOutDir (input) {
  return FILTER_OUT_DIR.includes(input)
}

/**
 * produce RegExp to match local path
 * @param {string} localPath
 * @return {RegExp}
 */
function generateLocalPathReg (localPath) {
  const pathArr = localPath
    .split(DEFAULT_SEP)
  const len = pathArr.length
  const regStr = pathArr
    .map((part, index) => {
      if (index === len - 1) {
        return `${part}`
      } else {
        return `\\.?(${part})?`
      }
    })
    .join(`\\${DEFAULT_SEP}?`)
  return new RegExp(regStr, 'g')
}

/**
 * find file usage
 * 1. make sure the range: srcPath
 * 2. provide inline path to search and to replace with: localCdnPair
 * @param {string} srcPath
 * @param {string} distPath
 * @return {function}
 */
function simpleReplace (srcPath, distPath = srcPath) {
  const srcFile = fs.readFileSync(srcPath, 'utf-8')
  return function savePair (localCdnPair) {
    const ret = localCdnPair
      .reduce((last, file) => {
        const localPath = normalize(file[0])
        const cdnPath = file[1]
        const localPathReg = generateLocalPathReg(localPath)
        last = last.replace(localPathReg, match => cdnPath)
        return last
      }, srcFile)
    fse.ensureFileSync(distPath)
    fs.writeFileSync(distPath, ret)
  }
}

/**
 * gather specific file type within directory provided
 * 1. provide range to search: src
 * 2. provide the type of file to search: type
 * @param {string} src: directory to search
 * @return {function}
 */
function gatherFileIn (src) {
  return function gatherFileType (type) {
    return fs.readdirSync(src)
      .reduce((last, file) => {
        const filePath = resolve(src, file)
        if (isFile(filePath)) {
          path.extname(file) === `.${type}` && last.push(normalize(filePath))
        } else if (isFilterOutDir(file)) {
          // do nothing
        } else if (isDir(filePath)) {
          last = last.concat(gatherFileIn(filePath)(type))
        }
        return last
      }, [])
  }
}

function isFile (input) {
  return fs.statSync(input).isFile()
}

function isDir (input) {
  return fs.statSync(input).isDirectory()
}

function isType (type) {
  return function enterFile (file) {
    return isFile(file) && path.extname(file) === '.' + type
  }
}

/**
 * give the power of playing with cdn url
 * @param {string[][]} entries
 * @param {function} cb
 * @returns {[string, string][]}
 */
function processCdnUrl (entries, cb) {
  if (typeof cb !== 'function') return console.error(`[${name}]: urlCb is not function`)
  return entries.map(pair => {
    // pair[1] should be cdn url
    pair[1] = cb(pair[1])
    if (typeof pair[1] !== 'string') console.error(`[${name}]: the return result of urlCb is not string`)
    return pair
  })
}

function mapSrcToDist (srcFilePath, srcRoot, distRoot) {
  return srcFilePath.replace(srcRoot, distRoot)
}

const isJpg = isType('jpg')
const isPng = isType('png')
const isGif = isType('gif')
const isWebp = isType('webp')
const isCss = isType('css')
const isJs = isType('js')

/**
 * webpack upload plugin
 * early version need more work
 * @param {{upload: Promise}} cdn
 * custom cdn module, need to have an upload API, return a Promise with structured response
 * like {localPath: cdnPath}
 * @param {{src: string, dist: string}} option
 * provide information about what the source html directory and compiled html directory
 * @constructor
 */
function UploadPlugin (cdn, option = DEFAULT_OPTION) {
  this.cdn = cdn
  this.option = Object.assign({}, DEFAULT_OPTION, option)
}

UploadPlugin.prototype.apply = function (compiler) {
  const self = this
  // extra treatment for cdnUrl
  const urlCb = this.option.urlCb
  // could process other type of files rather than limited to html
  const resolveList = this.option.resolve
  // get absolute path of src and dist directory
  const srcRoot = resolve(this.option.src)
  const distRoot = resolve(this.option.dist)

  compiler.plugin('done', async function (stats) {
    const hash = stats.compilation.hash
    // all assets including js/css/img
    const assets = stats.compilation.assets
    const assetsNames = Object.keys(assets)
    // classify assets
    const desireAssets = assetsNames.reduce((last, name) => {
      const assetInfo = assets[name]
      const location = assetInfo.existsAt
      if (isGif(location) || isPng(location) || isJpg(location) || isWebp(location)) {
        last.img[name] = assetInfo
      } else if (isCss(location)) {
        last.css[name] = assetInfo
      } else if (isJs(location)) {
        last.js[name] = assetInfo
      }
      return last
    }, {
      img: {},
      css: {},
      js: {}
    })

    const {
      img,
      css,
      js
    } = desireAssets

    // make assets object to array with local path
    function makeArr (input) {
      return Object.keys(input)
        .map(name => {
          const info = input[name]
          return info.existsAt
        })
    }

    const imgArr = makeArr(img)

    // upload img
    // find img in css
    // replace css
    // now css ref to img with cdn path
    const imgPairs = await self.cdn.upload(imgArr)
    Object.keys(css)
      .forEach(name => {
        const location = css[name].existsAt
        simpleReplace(location)(processCdnUrl([...Object.entries(imgPairs)], urlCb))
      })
    // concat js + css
    const adjustedFiles = [...makeArr(js), ...makeArr(css)]
    const findFileInRoot = gatherFileIn(self.option.src)
    const tplFiles = resolveList.reduce((last, type) => {
      last = last.concat(findFileInRoot(type))
      return last
    }, [])
    const jsCssPair = await self.cdn.upload(adjustedFiles)
    const localCdnPair = Object.entries(jsCssPair)
    tplFiles
      .forEach(filePath => {
        simpleReplace(filePath, mapSrcToDist(filePath, srcRoot, distRoot))(processCdnUrl([...localCdnPair], urlCb))
      })
  })
}

module.exports = UploadPlugin
