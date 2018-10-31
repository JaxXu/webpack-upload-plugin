const fs = require('fs')
const fse = require('fs-extra')
const path = require('path')
const {
  parallel,
  compatCache,
  beforeUpload: beforeProcess
} = require('y-upload-utils')
const pjName = require('./package.json').name
const DEFAULT_SEP = '/'
const FILTER_OUT_DIR = ['.idea', '.vscode', '.gitignore', 'node_modules']
const PUBLIC_PATH_MATCH = /__webpack_require__\.p\s?=\s?([^;]+);/g
const getScriptRegExp = () =>
  /__webpack_require__\.p\s?\+[^\[]+\[(\S+)][\s\S]+?\.js['"];?/g
const getCssChunksRegExp = () => /var\scssChunks\s*=\s*([^;\n]+);/
const getCssHrefRegExp = () => /var\shref\s*=[^\n]+?chunkId[^\n;]+;/

// read file
const read = location => fs.readFileSync(location, 'utf-8')
// write file
const write = location => content => fs.writeFileSync(location, content)

/**
 * log information
 * @param {*} msg
 */
function log(msg) {
  console.log(`[${pjName}]: ${msg}`)
}

/**
 * log error
 * @param msg
 */
function logErr(msg) {
  console.error(`[${pjName}]: ${msg}`)
}

// remove publicPath from reference
const handlePublicPath = publicPath => content => {
  // match strictly
  const regStr = publicPath
    .split(DEFAULT_SEP)
    .filter(item => !!item)
    .map(part => {
      if (/\./.test(part)) {
        return part.replace(/\.+/g, match =>
          match
            .split('')
            .map(dot => '\\' + dot)
            .join('')
        )
      }
      return part
    })
    .join('\\/')
  const refinedRegStr = `([(=]['"]?)${regStr}`
  const reg = new RegExp(refinedRegStr, 'g')
  return content.replace(reg, (_, prefix) => (prefix ? prefix : ''))
}

// 1. gather html file
// 2. gather production file
// 3. upload all production file
// 4. find the usage of production file in html file
// 5. if found, replace

function resolve(...input) {
  return path.resolve(...input)
}

function normalize(input, sep = DEFAULT_SEP) {
  const _input = path.normalize(input)
  return _input.split(path.sep).join(sep)
}

function isFilterOutDir(input) {
  return FILTER_OUT_DIR.includes(input)
}

/**
 * given localPath, return string to form matching RegExp
 * @param {string} localPath
 */
function generateLocalPathStr(localPath) {
  const pathArr = localPath.split(DEFAULT_SEP)
  const len = pathArr.length
  return pathArr
    .map((part, index) => {
      if (index === len - 1) {
        return `${part}`
      } else {
        return `\\.?(${part})?`
      }
    })
    .join(`\\${DEFAULT_SEP}?`)
}

/**
 * produce RegExp to match local path
 * @param {string} localPath
 * @return {RegExp}
 */
function generateLocalPathReg(localPath) {
  const content = generateLocalPathStr(localPath)
  const prefix = `([(=+]\\s*['"]?)`
  // using prefix to strictly match resource reference
  // like src="", url(""), a = ""
  return new RegExp(`${prefix}${content}`, 'g')
}

/**
 * find file usage
 * 1. make sure the range: srcPath
 * 2. provide inline path to search and to replace with: localCdnPair
 * @param {string} srcPath
 * @param {string=} distPath
 * @param {function=} replaceFn
 * @param {boolean=} [copyWhenUntouched=true] copy file even if the content remains the same
 * @return {function}
 */
function simpleReplace(
  srcPath,
  distPath = srcPath,
  replaceFn = input => input,
  copyWhenUntouched = true
) {
  const srcFile = read(srcPath)
  return function savePair(localCdnPair) {
    const ret = localCdnPair.reduce((last, file) => {
      const localPath = normalize(file[0])
      const cdnPath = file[1]
      const localPathReg = generateLocalPathReg(localPath)

      last = replaceFn(last, srcPath).replace(
        localPathReg,
        (_, prefix) => `${prefix}${cdnPath}`
      )
      return last
    }, srcFile)
    // no such path > force copy > content change
    const toCopy =
      !fs.existsSync(distPath) || copyWhenUntouched || ret !== srcFile
    if (toCopy) {
      fse.ensureFileSync(distPath)
      write(distPath)(ret)
    }
  }
}

/**
 * gather specific file type within directory provided
 * 1. provide range to search: src
 * 2. provide the type of file to search: type
 * @param {string} src: directory to search
 * @return {function}
 */
function gatherFileIn(src) {
  return function gatherFileType(type) {
    return fs.readdirSync(src).reduce((last, file) => {
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

function isFile(input) {
  return fs.statSync(input).isFile()
}

function isDir(input) {
  return fs.statSync(input).isDirectory()
}

function isType(type) {
  return function enterFile(file) {
    return isFile(file) && path.extname(file) === '.' + type
  }
}

const handleCdnRes = cb => entries => {
  if (typeof cb !== 'function') return logErr(`urlCb is not function`)
  const isArr = Array.isArray(entries)
  // if not array, handle as {[localLocation]: [cdnUrl]}
  const target = isArr ? entries : Object.entries(entries)
  return target.map(pair => {
    // pair[1] should be cdn url
    // pass local path as well
    pair[1] = cb(pair[1], pair[0])
    if (typeof pair[1] !== 'string')
      logErr(`the return result of urlCb is not string`)
    return pair
  })
}

function mapSrcToDist(srcFilePath, srcRoot, distRoot) {
  return srcFilePath.replace(srcRoot, distRoot)
}

const imgTypeArr = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'ico']
const fontTypeArr = ['woff', 'woff2', 'ttf', 'oft', 'svg', 'eot']
const isCss = isType('css')
const isJs = isType('js')
const isOneOfType = (types = ['']) => file =>
  types.some(type => isType(type)(file))

function isFont(path) {
  return fontTypeArr.some(type => isType(type)(path))
}

function isImg(path) {
  return imgTypeArr.some(type => isType(type)(path))
}

/**
 * generate {id: name} object for all chunk chunk
 * @param {*[]} chunks
 * @param {string} chunkFileName
 */
function gatherChunks(chunks, chunkFileName) {
  return chunks.reduce((last, chunk) => {
    if (/\[hash(:\d+)?]/.test(chunkFileName)) {
      throw new Error(
        `[${pjName}]: Do NOT use [hash] as output filename! Use [chunkhash] or [contenthash] instead`
      )
    }
    const { id, name, renderedHash, contentHash } = chunk
    // handle slice properly
    const handleLen = source => (match, len) => {
      if (len) {
        return source.slice(0, +len.slice(1))
      }
      return match
    }
    const handleChunkHash = handleLen(renderedHash)
    // handle webpack@4 as well as <4
    const handleContentHash = handleLen(
      contentHash ? contentHash.javascript : renderedHash
    )
    last[id] = chunkFileName
      .replace(/\[name]/g, name || `${id}`)
      .replace(/\[id]/g, `${id}`)
      .replace(/\[chunkhash(:\d+)?]/g, handleChunkHash)
      .replace(/\[contenthash(:\d+)?]/g, handleContentHash)
    return last
  }, {})
}

/**
 * whether chunk is "entry" (common chunks is also considered as "entry")
 * @param {string} js
 */

function isEntryChunk(js) {
  const content = read(js)
  return getScriptRegExp().test(content)
}

/**
 * convert object to array
 * @param {object} obj
 */
function convertToArray(obj) {
  return Object.values(obj)
}

/**
 * update script.src property for request for dynamic import
 * experimental
 * @param {string[]} files
 * @param {{id: string}} chunkCdnMap
 */
function updateScriptSrc(files, chunkCdnMap) {
  // if no new map was formed, then keep the way it is
  const len = Object.keys(chunkCdnMap).length
  if (!len) return
  files.forEach(file => {
    const content = read(file)
    let newContent = content
    // update chunkMap
    if (getScriptRegExp().test(content)) {
      const srcAssignStr = `${JSON.stringify(chunkCdnMap)}[$1];`
      newContent = newContent.replace(getScriptRegExp(), srcAssignStr)
    }
    // update publicPath
    if (PUBLIC_PATH_MATCH.test(content)) {
      newContent = newContent.replace(
        PUBLIC_PATH_MATCH,
        `__webpack_require__.p = "";`
      )
    }
    write(file)(newContent)
  })
}

function updateCssLoad(files, cssMap) {
  const keys = cssMap.map(([local]) => local)
  files.forEach(file => {
    const content = read(file)
    let newContent = content
    const match = content.match(getCssChunksRegExp())
    if (match) {
      const [_, map] = match
      newContent = newContent.replace(getCssHrefRegExp(), hrefMatch => {
        // get the new cssMap with {chunkId, href} structure
        // where chunkId is the id for the css file, and href is the cdn url
        const fnBody = `
            const map = ${map};
            return Object.keys(map).map(chunkId => {
              ${hrefMatch};
              href = href.replace(/^\\./, "");
              return {chunkId, href};
            })
          `
        const hrefArr = new Function(fnBody)()
        // convert to {[chunkId]: href} structure
        const cssChunkIdCdnMap = hrefArr.reduce((last, { chunkId, href }) => {
          const localIndex = keys.findIndex(key => key.indexOf(href) > -1)
          if (localIndex < 0) {
            return last
          }
          last[chunkId] = cssMap[localIndex][1]
          return last
        }, {})
        // cannot form new Map, return the original one
        if (!Object.keys(cssChunkIdCdnMap).length) {
          return hrefMatch
        }
        const newCssMap = JSON.stringify(cssChunkIdCdnMap)
        return `var href = ${newCssMap}[chunkId];`
      })
      // update js entry file with new cssMap
      write(file)(newContent)
    }
  })
}

/**
 * get id of chunk given a absolute path of chunk file and id:chunk map
 * @param {string} chunkAbsPath
 * @param {{id: string}} chunkMap
 */
function getIdForChunk(chunkAbsPath, chunkMap) {
  return Object.keys(chunkMap).find(
    key => chunkAbsPath.indexOf(chunkMap[key]) > -1
  )
}

/**
 * @typedef {function(string): string} urlCb
 */

/**
 * webpack upload plugin
 * early version need more work
 * @param {{upload: Promise}} cdn
 * custom cdn module, need to have an upload API, return a Promise with structured response
 * like {localPath: cdnPath}
 * @param {object} option
 * @param {string=} option.src
 * @param {string=} option.dist
 * @param {(function(string, string=) => string)=} option.urlCb
 * @param {function=} option.onFinish
 * @param {(function(string, string=) => string)=} option.replaceFn
 * @param {(function(string, string) => string)=} option.beforeUpload
 * @param {(string|string[])=} option.staticDir
 * @param {(function() => Promise<*>)=} option.waitFor
 * @param {boolean=} [option.dirtyCheck=false]
 * @param {boolean=} option.logLocalFiles
 * @param {object=} option.passToCdn
 * @param {boolean=} [option.enableCache=false]
 * @param {string=} option.cacheLocation
 * @param {number=} [option.sliceLimit=10]
 * @param {boolean=} option.forceCopyTemplate
 * @param {boolean=} [option.asyncCSS=false]
 * @constructor
 */
function UploadPlugin(cdn, option = {}) {
  this.cdn = cdn
  this.option = option
}

UploadPlugin.prototype.apply = function(compiler) {
  const self = this
  const {
    urlCb = input => input,
    resolve: resolveList = ['html'],
    src = '',
    dist = src,
    onFinish = () => {},
    onError = () => {},
    logLocalFiles: logLocal = false,
    staticDir = '',
    replaceFn = input => input,
    beforeUpload,
    waitFor = () => Promise.resolve(true),
    dirtyCheck = false,
    passToCdn,
    enableCache = false,
    cacheLocation,
    sliceLimit,
    forceCopyTemplate,
    asyncCSS = false
  } = this.option
  // get absolute path of src and dist directory
  const srcRoot = resolve(src)
  const distRoot = resolve(dist)
  const getLocal2CdnObj = handleCdnRes(urlCb)
  const isTemplate = isOneOfType(resolveList)

  /**
   * update chunkMap to {[id: string|number]: cdnUrl}
   * @param {{[localPath: string]: string}} chunkPairs
   * @param {{[id: string|number]: string}} chunkMap
   * @param {*} start
   */
  function generateChunkMapToCDN(chunkPairs, chunkMap, start = {}) {
    return getLocal2CdnObj(chunkPairs).reduce((last, [localPath, cdnPath]) => {
      const id = getIdForChunk(localPath, chunkMap)
      last[id] = cdnPath
      return last
    }, start)
  }

  // wrap a new cdn object
  const rawCdn = {
    upload(files) {
      return self.cdn.upload(files, passToCdn)
    }
  }

  // log error for cache setup
  if (!enableCache && cacheLocation) {
    logErr(`'cacheLocation' provided while haven't set 'enableCache' to true`)
    logErr(`This won't enable cache`)
  }

  // wrap with parallel
  const paralleledCdn = parallel(rawCdn, { sliceLimit })

  // wrap with cache
  const wrappedCdn = enableCache
    ? compatCache(paralleledCdn, {
        passToCdn,
        cacheLocation
      })
    : paralleledCdn

  // wrap with beforeProcess
  // use beforeUpload properly
  const cdn = beforeProcess(wrappedCdn, beforeUpload)

  compiler.plugin('done', async function(stats) {
    try {
      // wait to handle extra logic
      await waitFor()
      const { chunks, options } = stats.compilation
      const {
        output: { publicPath = '' },
        mode
      } = options
      // early warning
      if (mode && mode !== 'none') {
        log("WARNING! Set the mode to 'none' to make it works!")
      }
      if (publicPath) {
        log(
          'WARNING! publicPath is not empty, the plugin will try to handle it for you. But it is preferred to toggle it by yourself!'
        )
      }
      // don't want to use publicPath since about to use cdn url
      const removePublicPath = handlePublicPath(publicPath)
      // actual replaceFn that gonna be used
      const refinedReplaceFn = (content, location) => {
        const type = path.extname(location)
        // only remove publicPath occurrence for css/template files
        // it's tricky to handle js files
        const removePublicPathTypes = ['.css', ...resolveList.map(t => `.${t}`)]
        const toRemove = removePublicPathTypes.includes(type)
        return replaceFn(
          toRemove ? removePublicPath(content) : content,
          location
        )
      }
      // if user offers staticDir
      // then only collect files from staticDir
      // instead of ones provided by webpack
      // if pass in an array, gather files recursively
      const gatherManualAssets = Array.isArray(staticDir)
        ? type => {
            return staticDir.reduce((last, dir) => {
              return [...last, ...gatherFileIn(dir)(type)]
            }, [])
          }
        : gatherFileIn(staticDir)
      const manualAssets = staticDir
        ? [...imgTypeArr, ...fontTypeArr, 'css', 'js', ...resolveList].reduce(
            (last, type) => {
              const files = gatherManualAssets(type)
              return files.reduce((fileLast, file) => {
                return Object.assign(fileLast, {
                  [file]: {
                    existsAt: file
                  }
                })
              }, last)
            },
            {}
          )
        : {}
      // here we get chunks needs to be dealt with
      const chunkMap = gatherChunks(chunks, options.output.chunkFilename)
      // all assets including js/css/img
      const { assets } = staticDir
        ? { assets: manualAssets }
        : stats.compilation
      const assetsNames = Object.keys(assets)
      // classify assets
      const desireAssets = assetsNames.reduce(
        (last, name) => {
          const assetInfo = assets[name]
          const location = assetInfo.existsAt
          if (isImg(location)) {
            last.img[name] = assetInfo
          } else if (isCss(location)) {
            last.css[name] = assetInfo
          } else if (isJs(location)) {
            last.js[name] = assetInfo
          } else if (isFont(location)) {
            last.font[name] = assetInfo
          } else if (isTemplate(location)) {
            last.html[name] = assetInfo
          }
          return last
        },
        {
          img: {},
          css: {},
          js: {},
          font: {},
          html: {}
        }
      )

      const { img, css, js, font, html } = desireAssets

      // warning if no template found but staticDir set
      if (staticDir && !Object.keys(html).length && !src) {
        log('WARNING!')
        log(
          "staticDir is set but haven't found any template files in those directories"
        )
        log('Try to use src filed to include your template files')
      }

      // make assets object to array with local path
      function makeArr(input) {
        return Object.keys(input).map(name => {
          const info = input[name]
          return info.existsAt
        })
      }

      const imgArr = makeArr(img)
      const fontArr = makeArr(font)
      const jsArr = makeArr(js)
      const cssArr = makeArr(css)
      const htmlArr = makeArr(html)
      const chunkArr = convertToArray(chunkMap)
      const commonChunksArr = jsArr.filter(isEntryChunk)

      // find out which js files are chunk chunk, common chunk, or entry
      const { notChunkJsArr, chunkArrWAbs, commonChunksWAbs } = jsArr.reduce(
        (last, js) => {
          const isCommonChunk = commonChunksArr.some(
            chunk => js.indexOf(chunk) > -1
          )
          const isChunk =
            !isCommonChunk && chunkArr.some(chunk => js.indexOf(chunk) > -1)
          if (isCommonChunk) {
            last.commonChunksWAbs.push(js)
          } else if (isChunk) {
            last.chunkArrWAbs.push(js)
          } else {
            last.notChunkJsArr.push(js)
          }
          return last
        },
        {
          notChunkJsArr: [],
          chunkArrWAbs: [],
          commonChunksWAbs: []
        }
      )

      // upload img/font
      // find img/font in css
      // replace css
      // now css ref to img/font with cdn path
      // meanwhile upload chunk files to save time
      log('uploading img and font...')
      logLocal && console.log([...imgArr, ...fontArr])
      const imgAndFontPairs = await cdn.upload([...imgArr, ...fontArr])
      // update img/font reference in css/js files
      // including chunk files
      log('update css/js files with new img and font...')
      const needToUpdateFiles = [...jsArr, ...cssArr]
      needToUpdateFiles.forEach(location =>
        simpleReplace(location, location, refinedReplaceFn)(
          getLocal2CdnObj(imgAndFontPairs)
        )
      )
      // upload chunk files
      log('uploading chunks...')
      const chunkPairs = await cdn.upload(chunkArrWAbs)
      // update chunkMap, so far no cdn url for common chunks
      let newChunkMap = generateChunkMapToCDN(chunkPairs, chunkMap, {})
      log('uploading css...')
      const cssLocal2CdnObj = await cdn.upload(cssArr)
      if (asyncCSS) {
        updateCssLoad(commonChunksWAbs, getLocal2CdnObj(cssLocal2CdnObj))
      }
      // entry chunk is just entry file : )
      // the reason uploading common as well as entry is to support webpack@4 and < 4
      // have common/entry chunks, update chunkMap within it
      // upload them, so their cdn url can be added to newChunkMap
      // then entries can be updated with newChunkMap that has cdn url for common chunks
      let commonChunksPair = {}
      if (commonChunksWAbs.length) {
        updateScriptSrc(commonChunksWAbs, newChunkMap)
        log('upload common/entry chunks...')
        commonChunksPair = await cdn.upload(commonChunksWAbs)
        newChunkMap = generateChunkMapToCDN(
          commonChunksPair,
          chunkMap,
          newChunkMap
        )
      }
      // if use dirty check, then check all js files for chunkMap
      // since webpack@4, every js is chunk
      // so only filter out common/entry chunks since they should be updated
      // and uploaded right above
      const manifestList = dirtyCheck
        ? jsArr
        : jsArr.filter(js => !commonChunksWAbs.includes(js))
      updateScriptSrc(manifestList, newChunkMap)

      // only js here
      const adjustedFiles = [...manifestList]
      // if provide with src
      // then use it
      // or use emitted html files
      const tplFiles = !src
        ? htmlArr
        : resolveList.reduce((last, type) => {
            const findFileInRoot = gatherFileIn(src)
            last = last.concat(findFileInRoot(type))
            return last
          }, [])

      log('uploading js...')
      logLocal && console.log(adjustedFiles)
      const jsLocal2CdnObj = await cdn.upload(adjustedFiles)
      // reuse image/common chunks result here
      // ! important to reuse common chunks since they could just by entry files
      const allLocal2CdnObj = Object.assign(
        jsLocal2CdnObj,
        cssLocal2CdnObj,
        imgAndFontPairs,
        commonChunksPair
      )
      tplFiles.forEach(filePath => {
        simpleReplace(
          filePath,
          mapSrcToDist(filePath, srcRoot, distRoot),
          refinedReplaceFn,
          forceCopyTemplate
        )(getLocal2CdnObj(allLocal2CdnObj))
      })
      // run onFinish if it is a valid function
      onFinish()
      log('all done')
    } catch (e) {
      log('err occurred!')
      console.log(e)
      // run when encounter error
      onError(e)
    }
  })
}

module.exports = UploadPlugin
