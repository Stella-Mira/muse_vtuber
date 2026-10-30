/**
 * muse_vtuber / models.js —— 模型清单与资源诊断（只读，零第三方依赖）
 *
 * 为什么要单独一层：功能点3（侧边栏的表情菜单）和功能点9（资源缺失时要说清缺哪个文件、
 * 从哪配）都靠它。旧版看板娘只 pop 一句「模型加载失败」，排查时不知道该补哪个文件。
 *
 * 约定2：modelsDir 只影响显示，允许有默认值 —— 但「默认取哪」必须写进 README 与 status
 * （resolveModelsDir() 在 config.js 里，顺序：手填 > muse_vtuber/model > mira_live2d/model）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, sep } from 'node:path'

import { MiraError } from './kit.mjs'

export const MODEL_FILE_SUFFIX = '.model3.json'

/** 叠加型表情的前缀（和 mira_live2d 同一套约定，模型作者按这个命名）。 */
const ADDITIVE_PREFIXES = ['开关-', '动作-', '开关_', '动作_']

function readDirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function isModelFile(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith(MODEL_FILE_SUFFIX)
}

/**
 * 扫 modelsDir：一层目录（`<dir>/<Name>/<Name>.model3.json`）与平铺文件都认。
 * 返回 { dir, models:[{ name, entry, file }] }，不抛（目录不存在 = 空清单，由调用方给提示）。
 */
export function scanModels(dir) {
  const models = []
  if (typeof dir !== 'string' || dir.trim() === '') return { dir: '', models }
  for (const entry of readDirSafe(dir)) {
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name)
      for (const file of readDirSafe(sub)) {
        if (file.isFile() && isModelFile(file.name)) {
          models.push({
            name: entry.name,
            entry: entry.name + '/' + file.name,
            file: join(sub, file.name),
          })
        }
      }
      continue
    }
    if (entry.isFile() && isModelFile(entry.name)) {
      models.push({ name: entry.name.slice(0, -MODEL_FILE_SUFFIX.length), entry: entry.name, file: join(dir, entry.name) })
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name))
  return { dir, models }
}

/** 按名字（目录名 / 文件名 / entry）找模型；找不到抛 config/missing 并说清去哪配。 */
export function findModel(dir, name) {
  const { models } = scanModels(dir)
  const want = String(name ?? '').trim()
  if (want === '') {
    if (models.length === 0) {
      throw new MiraError('config/missing',
        '模型目录里没有任何 *' + MODEL_FILE_SUFFIX + '：' + (dir || '(未配置)'),
        '把模型目录（含 <Name>/<Name>' + MODEL_FILE_SUFFIX + '）放到 ' + (dir || '<modelsDir>')
          + '，或在设置页把「模型目录」填到正确位置')
    }
    return models[0]
  }
  const hit = models.find((m) => m.name === want || m.entry === want || m.file === want)
  if (hit) return hit
  throw new MiraError('config/missing',
    '找不到模型 ' + JSON.stringify(want) + '（目录：' + (dir || '(未配置)') + '）',
    '可用模型：' + (models.map((m) => m.name).join('、') || '（空）')
      + '；把模型放进该目录，或改设置页的「模型」')
}

/** 读 model3.json（坏 JSON 报 config/corrupt，不静默当空模型）。 */
export function readModel3(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    throw new MiraError('config/missing', '读不到模型文件：' + file + '（' + (error?.message || error) + '）',
      '确认文件存在且可读；模型要去掉 macOS 的隔离属性（xattr -d com.apple.quarantine）')
  }
  try {
    const raw = JSON.parse(text)
    if (!raw || typeof raw !== 'object') throw new Error('不是 JSON 对象')
    return raw
  } catch (error) {
    throw new MiraError('config/corrupt', '模型文件不是合法 JSON：' + file + '（' + (error?.message || error) + '）',
      '重新导出模型；不要手动编辑 moc3 旁边的 model3.json')
  }
}

/**
 * 表情/动作清单 + 资源缺失诊断。
 * 返回 { model, entry, expressions:[{name, additive}], motions:[names], missing:[{file, why}] }
 */
export function capabilities(dir, name) {
  const model = findModel(dir, name)
  const raw = readModel3(model.file)
  const refs = raw.FileReferences && typeof raw.FileReferences === 'object' ? raw.FileReferences : {}

  const expressions = []
  for (const item of Array.isArray(refs.Expressions) ? refs.Expressions : []) {
    const exprName = typeof item?.Name === 'string' ? item.Name.trim() : ''
    if (exprName === '') continue
    expressions.push({
      name: exprName,
      additive: ADDITIVE_PREFIXES.some((prefix) => exprName.startsWith(prefix)),
    })
  }

  const motions = []
  if (refs.Motions && typeof refs.Motions === 'object') {
    for (const [group, list] of Object.entries(refs.Motions)) {
      if (Array.isArray(list) && list.length) motions.push(group)
    }
  }

  // 资源缺失诊断：moc / 贴图 / 物理 / 表情 / 动作 逐个 stat，缺什么就报什么（功能点9）
  const missing = []
  const modelDir = dirname(model.file)
  const check = (rel, why) => {
    if (typeof rel !== 'string' || rel.trim() === '') return
    const full = join(modelDir, ...rel.split(/[\\/]+/).filter(Boolean))
    if (!existsSync(full)) missing.push({ file: rel, why })
  }
  check(refs.Moc, 'moc3 模型本体')
  for (const texture of Array.isArray(refs.Textures) ? refs.Textures : []) check(texture, '贴图')
  check(refs.Physics, '物理')
  check(refs.Pose, '姿势')
  for (const item of Array.isArray(refs.Expressions) ? refs.Expressions : []) check(item?.File, '表情 ' + (item?.Name || ''))
  if (refs.Motions && typeof refs.Motions === 'object') {
    for (const list of Object.values(refs.Motions)) {
      for (const item of Array.isArray(list) ? list : []) check(item?.File, '动作')
    }
  }

  return {
    model: model.name,
    entry: model.entry,
    expressions,
    motions,
    missing,
    dir,
  }
}

function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf(sep), p.lastIndexOf('\\'))
  return i <= 0 ? p : p.slice(0, i)
}

/** 服务端静态路由用：把 URL 相对路径安全地拼到根目录下（越界返回 null）。 */
export function safeJoin(root, relPath) {
  const parts = String(relPath || '').split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => part === '..' || part.includes('\u0000'))) return null
  const full = join(root, ...parts)
  return full
}

/** 给浏览器的能力包（不含绝对路径）。 */
export function publicCapabilities(caps) {
  return {
    model: caps.model,
    entry: caps.entry,
    expressions: caps.expressions,
    motions: caps.motions,
    missing: caps.missing,
    dirConfigured: typeof caps.dir === 'string' && caps.dir !== '',
    dirExists: (() => {
      try {
        return statSync(caps.dir).isDirectory()
      } catch {
        return false
      }
    })(),
  }
}

export function extensionOf(file) {
  return extname(String(file || '')).toLowerCase()
}
