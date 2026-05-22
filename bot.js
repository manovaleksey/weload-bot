require('dotenv').config()
const { Telegraf } = require('telegraf')
const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const path = require('path')
const fs = require('fs')
const os = require('os')
const https = require('https')
const http = require('http')

const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) { console.error('BOT_TOKEN not set'); process.exit(1) }

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 10 * 60 * 1000 })

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

async function y2metaFetch(url) {
  try {
    const res = await fetch('https://y2meta.co.com/search/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://y2meta.co.com/en/youtube-to-mp4/',
        'User-Agent': UA, 'Origin': 'https://y2meta.co.com',
      },
      body: `query=${encodeURIComponent(url)}`,
      signal: AbortSignal.timeout(30000), redirect: 'follow',
    })
    const html = await res.text()
    const mp4 = html.match(/href=["'](https?:\/\/[^"']+\.mp4[^"']{0,200})["']/i)
    return mp4 ? mp4[1].replace(/&amp;/g, '&') : null
  } catch { return null }
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
function ytdlpDownload(url, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--no-playlist', '-o', outPath,
      '--ffmpeg-location', FFMPEG,
      '--merge-output-format', 'mp4',
      '--no-call-home', '--no-check-certificates',
      '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
      url,
    ]
    const proc = spawn(YTDLP, args, { env: buildEnv() })
    let finalPath = outPath
    proc.stdout.on('data', d => {
      const m = d.toString().match(/\[download\] Destination: (.+)/)
      if (m) finalPath = m[1].trim()
      const mg = d.toString().match(/Merging formats into "(.+)"/)
      if (mg) finalPath = mg[1].trim()
    })
    proc.on('close', code => {
      if (code === 0) resolve(finalPath)
      else reject(new Error(`yt-dlp exited with code ${code}`))
    })
  })
}

// ── File size check ───────────────────────────────────────
const TG_MAX_BYTES = 50 * 1024 * 1024  // 50 MB

function fileSize(p) {
  try { return fs.statSync(p).size } catch { return 0 }
}

// ── Main download logic ───────────────────────────────────
async function handleUrl(url, statusMsg, ctx) {
  const platform = detectPlatform(url)
  const tmpDir   = os.tmpdir()
  const tmpId    = `weload_${Date.now()}`

  // Pinterest — savepin first, then yt-dlp
  if (platform === 'pinterest') {
    await statusMsg('⏳ Ищу видео/фото...')
    const fb = await savepinFetch(url)
    if (fb) {
      const ext  = fb.type === 'video' ? 'mp4' : 'jpg'
      const out  = path.join(tmpDir, `${tmpId}.${ext}`)
      await statusMsg('⬇️ Скачиваю...')
      await downloadFile(fb.url, out)
      return { file: out, type: fb.type }
    }
    // Fallback yt-dlp
    const out = path.join(tmpDir, `${tmpId}.mp4`)
    const final = await ytdlpDownload(url, out)
    return { file: final, type: 'video' }
  }

  // TikTok — savett first, then yt-dlp
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

  // YouTube — y2meta first, then yt-dlp
  if (platform === 'youtube') {
    await statusMsg('⏳ Ищу видео...')
    const directUrl = await y2metaFetch(url)
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

bot.start(ctx => ctx.reply(
  '👋 Привет! Я Weload-бот.\n\n' +
  'Скинь мне ссылку на видео или фото:\n' +
  '• TikTok\n• YouTube\n• Pinterest\n• Instagram\n• Vimeo\n\n' +
  'И я пришлю файл прямо сюда.'
))

bot.help(ctx => ctx.reply(
  'Просто отправь ссылку — я скачаю и пришлю файл.\n\n' +
  '⚠️ Файлы до 50 МБ отправляются напрямую.\n' +
  'Для больших файлов пришлю ссылку на скачивание.'
))

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim()
  if (!isUrl(text)) {
    return ctx.reply('Отправь мне ссылку на видео 🔗')
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

    if (size > TG_MAX_BYTES) {
      await ctx.telegram.deleteMessage(ctx.chat.id, statusMessage.message_id).catch(() => {})
      return ctx.reply(`⚠️ Файл слишком большой для Telegram (${Math.round(size/1024/1024)} МБ > 50 МБ).\nСкачай вручную по этой ссылке:\n${text}`)
    }

    await editStatus('📤 Отправляю...')

    await sendWithRetry(ctx, filePath, result.type)

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

console.log('Weload bot started — @weloadbot_bot')
