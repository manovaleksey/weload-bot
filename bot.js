require('dotenv').config()
const { Telegraf, Markup } = require('telegraf')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')
const http = require('http')
const Database = require('better-sqlite3')

const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1) }

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 10 * 60 * 1000 })

// ── Database ──────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'weload.db')
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })
const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    free_downloads INTEGER DEFAULT 0,
    subscribed_until INTEGER DEFAULT 0
  )
`)

const FREE_LIMIT = 5

function getUser(userId) {
  let user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId)
  if (!user) {
    db.prepare('INSERT INTO users (user_id) VALUES (?)').run(userId)
    user = db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId)
  }
  return user
}

function isSubscribed(user) {
  return user.subscribed_until > Math.floor(Date.now() / 1000)
}

function canDownload(user) {
  return isSubscribed(user) || user.free_downloads < FREE_LIMIT
}

function incrementDownloads(userId) {
  db.prepare('UPDATE users SET free_downloads = free_downloads + 1 WHERE user_id = ?').run(userId)
}

function grantSubscription(userId, days) {
  const now = Math.floor(Date.now() / 1000)
  const user = getUser(userId)
  const currentExpiry = Math.max(user.subscribed_until, now)
  const newExpiry = currentExpiry + days * 86400
  db.prepare('UPDATE users SET subscribed_until = ? WHERE user_id = ?').run(newExpiry, userId)
}

// ── Plans ─────────────────────────────────────────────────
const PLANS = {
  month:   { label: '1 месяц',   stars: 299,  days: 30  },
  half:    { label: '6 месяцев', stars: 799,  days: 180 },
  year:    { label: '1 год',     stars: 1299, days: 365 },
}

function plansKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐️ 1 месяц — 299 звёзд',   'buy_month')],
    [Markup.button.callback('⭐️ 6 месяцев — 799 звёзд', 'buy_half')],
    [Markup.button.callback('⭐️ 1 год — 1 299 звёзд',   'buy_year')],
  ])
}

// ── Binaries ──────────────────────────────────────────────
const IS_WIN  = process.platform === 'win32'
const BIN_DIR = path.join(__dirname, 'bin')
const YTDLP   = path.join(BIN_DIR, IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
const FFMPEG  = path.join(BIN_DIR, IS_WIN ? 'ffmpeg.exe' : 'ffmpeg')

function buildEnv() {
  const sep = IS_WIN ? ';' : ':'
  return { ...process.env, PATH: [BIN_DIR, process.env.PATH || ''].join(sep) }
}

// ── Platform detection ────────────────────────────────────
function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be'))   return 'youtube'
  if (url.includes('tiktok.com') || url.includes('vm.tiktok'))   return 'tiktok'
  if (url.includes('pinterest.')  || url.includes('pin.it'))     return 'pinterest'
  if (url.includes('instagram.com') || url.includes('instagr.am')) return 'instagram'
  if (url.includes('vimeo.com'))                                  return 'vimeo'
  return 'generic'
}

function isUrl(text) {
  return /^https?:\/\//i.test(text.trim())
}

// ── Web service fallbacks ─────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function savepinFetch(url) {
  try {
    const res = await fetch(`https://www.savepin.app/download.php?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': UA, 'Referer': 'https://www.savepin.app/pinterest-downloader/' },
      signal: AbortSignal.timeout(25000), redirect: 'follow',
    })
    const html = await res.text()
    const mp4 = html.match(/href=["'](https?:\/\/[^"']+\.mp4[^"']{0,200})["']/i)
    if (mp4) return { url: mp4[1].replace(/&amp;/g, '&'), type: 'video' }
    const img = html.match(/href=["'](https?:\/\/[^"']+\.(jpg|jpeg|png|webp)[^"']{0,200})["']/i)
    if (img) return { url: img[1].replace(/&amp;/g, '&'), type: 'image' }
    return null
  } catch { return null }
}

async function savettFetch(url) {
  try {
    const pageRes = await fetch('https://savett.cc/ru/', {
      headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000),
    })
    const pageHtml = await pageRes.text()
    const cookies = (pageRes.headers.getSetCookie ? pageRes.headers.getSetCookie() : [pageRes.headers.get('set-cookie') || ''])
      .map(c => c.split(';')[0]).filter(Boolean).join('; ')
    const csrfMatch = pageHtml.match(/name="csrf_token"\s+value="([^"]+)"/)
    if (!csrfMatch) return null

    const dlRes = await fetch('https://savett.cc/ru/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://savett.cc/ru/', 'Cookie': cookies,
        'User-Agent': UA, 'Origin': 'https://savett.cc',
      },
      body: `url=${encodeURIComponent(url)}&csrf_token=${encodeURIComponent(csrfMatch[1])}`,
      signal: AbortSignal.timeout(30000), redirect: 'follow',
    })
    const html = await dlRes.text()
    const mp4 = html.match(/href=["'](https?:\/\/[^"']+\.mp4[^"']{0,200})["']/i)
    return mp4 ? mp4[1].replace(/&amp;/g, '&') : null
  } catch { return null }
}

function extractYoutubeId(url) {
  const m = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

async function innertubeFetch(url) {
  const videoId = extractYoutubeId(url)
  if (!videoId) return null
  try {
    const res = await fetch('https://www.youtube.com/youtubei/v1/player', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone16,2; U; CPU iOS 17_5 like Mac OS X)',
        'X-Youtube-Client-Name': '5',
        'X-Youtube-Client-Version': '19.09.3',
      },
      body: JSON.stringify({
        videoId,
        context: { client: { clientName: 'IOS', clientVersion: '19.09.3', deviceModel: 'iPhone16,2', hl: 'en', gl: 'US' } },
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) { console.log('innertube skip:', res.status); return null }
    const data = await res.json()
    if (data?.playabilityStatus?.status !== 'OK') {
      console.log('innertube not ok:', data?.playabilityStatus?.status)
      return null
    }
    const formats = data?.streamingData?.formats || []
    const adaptive = data?.streamingData?.adaptiveFormats || []
    const all = [...formats, ...adaptive]
    const mp4 = all
      .filter(f => f.mimeType?.includes('video/mp4') && f.url && f.height)
      .sort((a, b) => b.height - a.height)
      .find(f => f.height <= 720)
    if (mp4?.url) { console.log('innertube ok:', mp4.height + 'p'); return mp4.url }
  } catch (e) {
    console.log('innertube error:', e.message)
  }
  return null
}

// ── Direct download helper ────────────────────────────────
function downloadFile(fileUrl, savePath) {
  return new Promise((resolve, reject) => {
    const mod = fileUrl.startsWith('https') ? https : http
    const file = fs.createWriteStream(savePath)
    mod.get(fileUrl, { headers: { 'User-Agent': UA } }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        file.close(); fs.unlink(savePath, () => {})
        return resolve(downloadFile(res.headers.location, savePath))
      }
      res.pipe(file)
      file.on('finish', () => { file.close(); resolve(savePath) })
    }).on('error', err => { fs.unlink(savePath, () => {}); reject(err) })
  })
}

// ── yt-dlp download ───────────────────────────────────────
let cookiesFilePath = null
if (process.env.YOUTUBE_COOKIES) {
  cookiesFilePath = path.join(os.tmpdir(), 'yt_cookies.txt')
  fs.writeFileSync(cookiesFilePath, process.env.YOUTUBE_COOKIES)
}

function normalizeYoutubeUrl(url) {
  return url.replace(/youtube\.com\/shorts\/([A-Za-z0-9_-]+)/, 'youtube.com/watch?v=$1')
}

function ytdlpDownload(url, outPath) {
  const normalizedUrl = normalizeYoutubeUrl(url)
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '-o', outPath,
      '--ffmpeg-location', FFMPEG,
      '--merge-output-format', 'mp4',
      '--no-call-home', '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=web,default',
      '-f', 'bv[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/bv[height<=720]+ba/b[height<=720]/b',
    ]
    if (cookiesFilePath) args.push('--cookies', cookiesFilePath)
    args.push(normalizedUrl)
    const proc = spawn(YTDLP, args, { env: buildEnv() })
    let finalPath = outPath
    let stderr = ''
    proc.stdout.on('data', d => {
      const m = d.toString().match(/\[download\] Destination: (.+)/)
      if (m) finalPath = m[1].trim()
      const mg = d.toString().match(/Merging formats into "(.+)"/)
      if (mg) finalPath = mg[1].trim()
    })
    proc.stderr.on('data', d => { stderr += d.toString() })
    proc.on('close', code => {
      if (code === 0) resolve(finalPath)
      else reject(new Error(`yt-dlp code ${code}: ${stderr.slice(-300)}`))
    })
  })
}

// ── File size check ───────────────────────────────────────
const TG_MAX_BYTES = 50 * 1024 * 1024  // 50 MB
const TRANSFER_MAX_BYTES = 10 * 1024 * 1024 * 1024  // 10 GB

function fileSize(p) {
  try { return fs.statSync(p).size } catch { return 0 }
}

function uploadToTransfer(filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath)
    const fileStream = fs.createReadStream(filePath)
    const stat = fs.statSync(filePath)

    const options = {
      hostname: 'transfer.sh',
      path: `/${encodeURIComponent(fileName)}`,
      method: 'PUT',
      headers: {
        'Content-Length': stat.size,
        'Max-Days': '14',
      },
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        const url = data.trim()
        if (url.startsWith('https://')) resolve(url)
        else reject(new Error(`transfer.sh вернул: ${url}`))
      })
    })

    req.on('error', reject)
    fileStream.pipe(req)
  })
}

// ── Main download logic ───────────────────────────────────
async function handleUrl(url, statusMsg, ctx) {
  const platform = detectPlatform(url)
  const tmpDir   = os.tmpdir()
  const tmpId    = `weload_${Date.now()}`

  // Pinterest — savepin → yt-dlp
  if (platform === 'pinterest') {
    await statusMsg('⏳ Ищу видео/фото...')
    const fb = await savepinFetch(url)
    if (fb) {
      const ext = fb.type === 'video' ? 'mp4' : 'jpg'
      const out = path.join(tmpDir, `${tmpId}.${ext}`)
      await statusMsg('⬇️ Скачиваю...')
      await downloadFile(fb.url, out)
      return { file: out, type: fb.type }
    }
    const out = path.join(tmpDir, `${tmpId}.mp4`)
    const final = await ytdlpDownload(url, out)
    return { file: final, type: 'video' }
  }

  // TikTok — savett → yt-dlp
  if (platform === 'tiktok') {
    await statusMsg('⏳ Достаю ссылку...')
    const directUrl = await savettFetch(url)
    if (directUrl) {
      const out = path.join(tmpDir, `${tmpId}.mp4`)
      await statusMsg('⬇️ Скачиваю...')
      await downloadFile(directUrl, out)
      return { file: out, type: 'video' }
    }
    await statusMsg('⏳ Пробую через yt-dlp...')
    const out = path.join(tmpDir, `${tmpId}.mp4`)
    const final = await ytdlpDownload(url, out)
    return { file: final, type: 'video' }
  }

  // YouTube — innertube (iOS API) → yt-dlp
  if (platform === 'youtube') {
    await statusMsg('⏳ Ищу видео...')
    const invUrl = await innertubeFetch(url)
    if (invUrl) {
      const out = path.join(tmpDir, `${tmpId}.mp4`)
      await statusMsg('⬇️ Скачиваю...')
      await downloadFile(invUrl, out)
      return { file: out, type: 'video' }
    }
    await statusMsg('⏳ Пробую через yt-dlp...')
    const out = path.join(tmpDir, `${tmpId}.mp4`)
    const final = await ytdlpDownload(url, out)
    return { file: final, type: 'video' }
  }

  // Instagram, Vimeo, generic — yt-dlp
  await statusMsg('⏳ Скачиваю...')
  const out = path.join(tmpDir, `${tmpId}.mp4`)
  const final = await ytdlpDownload(url, out)
  return { file: final, type: 'video' }
}

// ── Send with retry ───────────────────────────────────────
async function sendWithRetry(ctx, filePath, type, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (type === 'image') {
        await ctx.replyWithPhoto({ source: filePath }, { caption: '⬇️ Weload' })
      } else {
        await ctx.replyWithVideo({ source: filePath }, {
          supports_streaming: true,
          caption: '⬇️ Weload',
        })
      }
      return
    } catch (err) {
      const isLastAttempt = i === attempts - 1
      if (isLastAttempt) {
        // Final fallback: send as document
        try {
          await ctx.replyWithDocument({ source: filePath }, { caption: '⬇️ Weload' })
          return
        } catch {
          throw err
        }
      }
      await new Promise(r => setTimeout(r, 2000 * (i + 1)))
    }
  }
}

// ── Bot handlers ──────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error('Bot error for', ctx.updateType, ':', err.message)
})

const mainKeyboard = Markup.keyboard([
  ['⚡️ Скачать', '❓ Помощь'],
]).resize()

function plansKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('⭐️ 1 месяц — 299 звёзд',   'buy_month')],
    [Markup.button.callback('⭐️ 6 месяцев — 799 звёзд', 'buy_half')],
    [Markup.button.callback('⭐️ 1 год — 1 299 звёзд',   'buy_year')],
  ])
}

bot.start(ctx => ctx.reply(
  '👋 Привет! Я Weload-бот.\n\n' +
  'Скинь мне ссылку на видео или фото:\n' +
  '• TikTok\n• YouTube\n• Pinterest\n• Instagram\n• Vimeo\n\n' +
  `🆓 Бесплатно: ${FREE_LIMIT} скачиваний. Затем нужна подписка.`,
  mainKeyboard
))

bot.help(ctx => ctx.reply(
  'Просто отправь ссылку — я скачаю и пришлю файл.\n\n' +
  '📦 До 50 МБ — файл придёт прямо в чат.\n' +
  '📁 До 10 ГБ — пришлю ссылку на скачивание (действует 14 дней).\n\n' +
  `🆓 Бесплатно: ${FREE_LIMIT} скачиваний\n` +
  '💫 Безлимит — по подписке через Telegram Stars.',
  mainKeyboard
))

bot.command('status', async (ctx) => {
  const user = getUser(ctx.from.id)
  if (isSubscribed(user)) {
    const exp = new Date(user.subscribed_until * 1000).toLocaleDateString('ru-RU')
    return ctx.reply(`✅ Подписка активна до ${exp}`, mainKeyboard)
  }
  const left = Math.max(0, FREE_LIMIT - user.free_downloads)
  return ctx.reply(
    `🆓 Бесплатных скачиваний осталось: ${left} из ${FREE_LIMIT}\n\nДля безлимита оформи подписку:`,
    plansKeyboard()
  )
})

// ── Subscription button handlers ──────────────────────────
for (const [key, plan] of Object.entries(PLANS)) {
  bot.action(`buy_${key}`, async (ctx) => {
    await ctx.answerCbQuery()
    await ctx.replyWithInvoice(
      `Weload — ${plan.label}`,
      `Безлимитное скачивание видео на ${plan.label}`,
      JSON.stringify({ plan: key }),
      'XTR',
      [{ label: plan.label, amount: plan.stars }]
    )
  })
}

bot.on('pre_checkout_query', ctx => ctx.answerPreCheckoutQuery(true))

bot.on('message', async (ctx, next) => {
  if (ctx.message?.successful_payment) {
    const payload = JSON.parse(ctx.message.successful_payment.invoice_payload)
    const plan = PLANS[payload.plan]
    if (plan) {
      grantSubscription(ctx.from.id, plan.days)
      return ctx.reply(`✅ Подписка оформлена на ${plan.label}! Скачивай без ограничений.`, mainKeyboard)
    }
  }
  return next()
})

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()

  if (text === '⚡️ Скачать') {
    return ctx.reply('Отправь мне ссылку на видео или фото 🔗\n\nПоддерживаю: TikTok, YouTube, Pinterest, Instagram, Vimeo', mainKeyboard)
  }

  if (text === '❓ Помощь') {
    return ctx.reply(
      'Просто отправь ссылку — я скачаю и пришлю файл.\n\n' +
      '📦 До 50 МБ — файл придёт прямо в чат.\n' +
      '📁 До 10 ГБ — пришлю ссылку на скачивание (действует 14 дней).\n\n' +
      `🆓 Бесплатно: ${FREE_LIMIT} скачиваний\n` +
      '💫 Безлимит — по подписке.',
      mainKeyboard
    )
  }

  if (!isUrl(text)) {
    return ctx.reply('Отправь мне ссылку на видео 🔗', mainKeyboard)
  }

  const user = getUser(ctx.from.id)
  if (!canDownload(user)) {
    return ctx.reply(
      `❌ Бесплатный лимит исчерпан (${FREE_LIMIT} скачиваний).\n\nОформи подписку, чтобы качать без ограничений:`,
      plansKeyboard()
    )
  }

  const statusMessage = await ctx.reply('⏳ Обрабатываю...')
  const editStatus = (text) => ctx.telegram.editMessageText(
    ctx.chat.id, statusMessage.message_id, undefined, text
  ).catch(() => {})

  let filePath = null
  try {
    const result = await handleUrl(text, editStatus, ctx)
    filePath = result.file
    const size = fileSize(filePath)

    if (size === 0) throw new Error('Файл пустой')

    if (size > TRANSFER_MAX_BYTES) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {})
      return ctx.reply(`⚠️ Файл слишком большой (${Math.round(size/1024/1024/1024)} ГБ). Максимум 10 ГБ.`)
    }

    if (size > TG_MAX_BYTES) {
      await editStatus('📤 Файл большой, загружаю на сервер...')
      const downloadUrl = await uploadToTransfer(filePath)
      if (!isSubscribed(user)) incrementDownloads(ctx.from.id)
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {})
      return ctx.reply(
        `✅ Готово! Файл ${Math.round(size/1024/1024)} МБ — скачай по ссылке:\n\n${downloadUrl}\n\n⏳ Ссылка действует 14 дней`
      )
    }

    await editStatus('📤 Отправляю...')

    await sendWithRetry(ctx, filePath, result.type)
    if (!isSubscribed(user)) incrementDownloads(ctx.from.id)

    await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {})

  } catch (err) {
    console.error('Error processing', text, ':', err.message, err.stack?.split('\n')[1] || '')
    await editStatus(`❌ Не удалось скачать.\n\nПроверь ссылку и попробуй снова.`).catch(() => {})
  } finally {
    if (filePath) fs.unlink(filePath, () => {})
  }
})

// ── Start ─────────────────────────────────────────────────
process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))

bot.launch().catch(err => {
  if (!err.message?.includes('timed out')) {
    console.error('Launch error:', err.message)
  }
})

console.log('Weload bot started — @weloadbot_bot v1.1.0 with cobalt+sqlite')
