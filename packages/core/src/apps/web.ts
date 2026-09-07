/**
 * BotWeb 面板入口（Karin 会自动加载本文件）
 * - 页面托管：GET /botweb（vite 构建产物 lib/webui 静态托管，SPA 兜底回 index.html）
 * - REST 接口：/botweb/api/*
 * - 实时推送：复用 Karin 内置 WebSocket 服务，接管路径 /botweb/ws
 */
import karin, { app, authMiddleware, hooks, logger } from 'node-karin'
import { WebSocket } from 'node-karin/ws'
import type { Request, Response } from 'node-karin/express'
import express from 'node-karin/express'
import path from 'node:path'
import fs from 'node:fs'
import apiRouter from '@/api'
import { toChatMessage, verifyWsToken, ProfileService } from '@/service'
import { dir } from '@/dir'

/** 面板挂载路径 */
const BASE = '/botweb'
/** WS 推送路径 */
const WS_PATH = `${BASE}/ws`

/** 已连接的面板客户端 */
const clients = new Set<WebSocket>()

/**
 * 表情回应状态表（NapCat 取消事件无标志的翻转推断用）：
 * `${selfId}:${peer}:${messageId}:${faceId}:${operatorId}` -> 当前是否已贴
 */
const reactionState = new Map<string, boolean>()

/** 广播消息给所有在线客户端 */
const broadcast = (payload: unknown) => {
  if (clients.size === 0) return
  const data = JSON.stringify(payload)
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN) socket.send(data)
  }
}

// -------------------- REST 接口（必须先于页面兜底注册） --------------------
// 复用 karin 官方鉴权中间件：凭据为 Authorization: Bearer <HTTP_AUTH_KEY 或 karin JWT>
// （JWT 需配合 x-user-id header；GET 还支持 ?token= 明文 key）
app.use(`${BASE}/api`, authMiddleware, apiRouter)

// -------------------- QQ 小黄脸静态资源（本地化，见 scripts/download-faces.mjs） --------------------
// 远程 jsDelivr 图床慢且易超时，表情文件下载到插件 resources/faces 下由本路由托管。
// 注意：sendFile 必须显式 dotfiles:'allow'——express/send 默认 dotfiles:'ignore'，
// 对路径含点目录段的文件直接 404；pnpm 部署时插件真实路径含 `.pnpm` 段
// （node_modules/.pnpm/karin-plugin-botweb@x.y.z/...），不放开会导致生产环境表情全部 404
const FACES_DIR = path.join(dir.pluginDir, 'resources', 'faces')

app.get(`${BASE}/faces/manifest.json`, (_req: Request, res: Response) => {
  const file = path.join(FACES_DIR, 'manifest.json')
  if (!fs.existsSync(file)) {
    res.status(404).json({ code: 404, message: 'faces not downloaded', data: null })
    return
  }
  res.setHeader('Cache-Control', 'public, max-age=86400')
  res.sendFile(file, { dotfiles: 'allow' })
})

app.get(`${BASE}/faces/:type/:name`, (req: Request, res: Response) => {
  // express v5 params 类型为 string | string[]，统一转字符串（数组形态随后会被正则挡下）
  const type = String(req.params.type)
  const name = String(req.params.name)
  // 只允许 gif/static 目录下的 s{id}.(gif|png)，防路径穿越
  if ((type !== 'gif' && type !== 'static') || !/^s\d+\.(gif|png)$/.test(name)) {
    res.status(404).json({ code: 404, message: 'not found', data: null })
    return
  }
  const file = path.join(FACES_DIR, type, name)
  if (!fs.existsSync(file)) {
    res.status(404).json({ code: 404, message: 'not found', data: null })
    return
  }
  res.setHeader('Cache-Control', 'public, max-age=604800, immutable')
  res.sendFile(file, { dotfiles: 'allow' })
})

// -------------------- 页面托管 --------------------
// vite 构建产物（packages/template 直接产出到 core/lib/webui，构建顺序 core 先 template 后）。
// express.static 同样必须 dotfiles:'allow'（pnpm 部署真实路径含 .pnpm 段，同 faces 的坑）
const WEBUI_DIR = path.join(dir.pluginDir, 'lib', 'webui')
const INDEX_HTML = path.join(WEBUI_DIR, 'index.html')

app.use(BASE, express.static(WEBUI_DIR, {
  dotfiles: 'allow',
  index: 'index.html',
  setHeaders: (res, filePath) => {
    // assets/ 下带内容 hash 长缓存；index.html 等不缓存，保证发版即时生效
    res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`)
      ? 'public, max-age=604800, immutable'
      : 'no-cache')
  }
}))

// SPA 兜底（express v5 通配符写法）：前端路由/刷新都回 index.html
app.get(`${BASE}/*splat`, (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache')
  res.sendFile(INDEX_HTML, { dotfiles: 'allow' })
})

// -------------------- WebSocket（复用 karin 内置 wss，按路径接管） --------------------
// karin 握手不鉴权，浏览器 WS 只能走 query 传凭据（?token=&user_id=），由插件自行校验
karin.on(`ws:connection:${WS_PATH}`, (socket: WebSocket, req: { url?: string }, call: () => void) => {
  // 必须在 3 秒内调用，否则 karin 会自动断开连接
  call()
  const query = new URL(req.url || '', 'http://localhost').searchParams
  if (!verifyWsToken(query.get('token') || undefined, query.get('user_id') || undefined)) {
    logger.warn('[BotWeb] 面板 WS 鉴权失败，已断开')
    socket.close(4401, 'unauthorized')
    return
  }
  clients.add(socket)
  logger.debug(`[BotWeb] 面板客户端已连接，当前 ${clients.size} 个`)
  const remove = () => {
    clients.delete(socket)
  }
  socket.on('close', remove)
  socket.on('error', remove)
})

// -------------------- 消息推送（全量广播，前端按当前选中的 Bot 过滤） --------------------
hooks.message((e, next) => {
  const message = toChatMessage(e)
  if (message) {
    broadcast({ type: 'message', data: message })
    // 异步补全会话资料（头像/名称，写 db 缓存）：qqbot 等没有列表接口的协议端靠它给会话补头像。
    // 不 await——缓存读写与协议端调用较慢，阻塞 hooks 会拖慢所有下游插件
    void ProfileService.syncMessage(e).then(updates => {
      if (updates) broadcast({ type: 'profiles', data: updates })
    })
  }
  // 必须调用 next()，否则事件会被吞掉，下游插件收不到
  next()
})

/**
 * node-karin@1.15 类型声明里私聊戳一戳/撤回的 accept key 是 notice.privatePoke / notice.privateRecall，
 * 但运行时事件的 subEvent 实际是 friendPoke / friendRecall，accept 按 `${event}.${subEvent}` 匹配，
 * 按声明的 key 注册永远收不到事件，这里按运行时 key 注册（断言绕过声明与运行时不一致的问题）。
 */
const PRIVATE_RECALL_EVENT = 'notice.friendRecall' as unknown as 'notice.privateRecall'
const PRIVATE_POKE_EVENT = 'notice.friendPoke' as unknown as 'notice.privatePoke'

/**
 * 撤回 / 戳一戳推送（戳一戳前端渲染为小灰条；撤回给原气泡打 recalled 标记，仅实时态）。
 * 注意：karin.accept() 只是创建插件对象，karin 扫描 apps 模块的**具名导出**完成注册
 * （default 导出会被跳过），不导出就是死代码，所以这里集中导出为数组。
 */
export const noticeHandlers = [
  // -------------------- 撤回推送 --------------------
  karin.accept(PRIVATE_RECALL_EVENT, (e, next) => {
    broadcast({
      type: 'recall',
      data: {
        selfId: e.selfId,
        messageId: e.content.messageId,
        scene: 'friend',
        peer: String(e.contact.peer),
        operatorId: String(e.content.operatorId),
        targetId: String(e.content.operatorId)
      }
    })
    next()
  }, { log: false }),

  karin.accept('notice.groupRecall', (e, next) => {
    broadcast({
      type: 'recall',
      data: {
        selfId: e.selfId,
        messageId: e.content.messageId,
        scene: 'group',
        peer: String(e.groupId),
        operatorId: String(e.content.operatorId),
        targetId: String(e.content.targetId)
      }
    })
    next()
  }, { log: false }),

  // -------------------- 戳一戳推送 --------------------
  karin.accept(PRIVATE_POKE_EVENT, (e, next) => {
    broadcast({
      type: 'poke',
      data: {
        selfId: e.selfId,
        scene: 'friend',
        peer: String(e.contact.peer),
        operatorId: String(e.content.operatorId),
        targetId: String(e.content.targetId),
        action: e.content.action || '戳了戳',
        suffix: e.content.suffix || ''
      }
    })
    next()
  }, { log: false }),

  karin.accept('notice.groupPoke', (e, next) => {
    broadcast({
      type: 'poke',
      data: {
        selfId: e.selfId,
        scene: 'group',
        peer: String(e.groupId),
        operatorId: String(e.content.operatorId),
        targetId: String(e.content.targetId),
        action: e.content.action || '戳了戳',
        suffix: e.content.suffix || ''
      }
    })
    next()
  }, { log: false }),

  // -------------------- 表情回应（QQ 贴表情）推送 --------------------
  // 前端给原气泡下方渲染 faceId 对应的 QFace + 次数（实时聚合，不落库）
  karin.accept('notice.groupMessageReaction', (e, next) => {
    const { messageId, faceId, count, isSet } = e.content
    const peer = String(e.contact.peer)
    const operatorId = String(e.sender.userId)
    // NapCat 的 group_msg_emoji_like 事件不带贴/取消标志（取消也发同构事件），karin 只能
    // 硬编码 isSet=true。按 QQ 语义（同一用户对同一表情只能贴一次）翻转推断：同一操作者
    // 对同一消息的同一表情再次「添加」实为取消。重启后状态丢失，首个事件按添加处理
    const stateKey = `${e.selfId}:${peer}:${messageId}:${faceId}:${operatorId}`
    const realIsSet = isSet ? reactionState.get(stateKey) !== true : false
    reactionState.set(stateKey, realIsSet)
    // 防止无限增长（上限 1 万条，淘汰最早写入的）
    if (reactionState.size > 10_000) {
      const oldest = reactionState.keys().next().value
      if (oldest !== undefined) reactionState.delete(oldest)
    }
    broadcast({
      type: 'reaction',
      data: {
        selfId: e.selfId,
        scene: 'group',
        peer,
        messageId: String(messageId),
        operatorId,
        faceId,
        count,
        isSet: realIsSet
      }
    })
    next()
  }, { log: false })
]

logger.info(`[BotWeb] 面板已挂载：http://127.0.0.1:7777${BASE}（接口已接入 karin 鉴权）`)
