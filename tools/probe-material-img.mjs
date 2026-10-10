#!/usr/bin/env node
/* 快速探针：进工作台滤镜页，读素材卡 img 的 src / complete / naturalWidth。 */
import { _electron as electron } from 'playwright-core'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const MAIN = path.join(ROOT, 'packages', 'desktop', 'src', 'main', 'index.js')
/* ⚠️ profile 放**系统临时目录**，不要放 _recon / _evidence（取证目录）：
   Electron 退出后句柄要过好几分钟才放，取证目录里的 profile 因此删不掉，
   取证卫生闸门会被自己清不掉的运行时垃圾顶红，而真因是"放错了地方"不是"没清"。 */
const PROFILE = path.join(os.tmpdir(), 'yjai-e2e', '.probe-img-profile')

const env = { ...process.env, NODE_ENV: 'production' }
delete env.ELECTRON_RUN_AS_NODE
delete env.YIJAI_USE_DEV_SERVER

const app = await electron.launch({
  executablePath: EXE,
  args: [MAIN, `--user-data-dir=${PROFILE}`, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  cwd: ROOT,
  env
})
const page = await app.firstWindow()
page.setDefaultTimeout(20000)
await page.waitForSelector('.home', { timeout: 30000 })
await page.locator('.home-hero-video').first().click()
await page.waitForSelector('.wb-timeline', { timeout: 20000 })
await page.locator('.wb-tab[data-wb-tab="filter"]').click()
await new Promise((r) => setTimeout(r, 1500))

const info = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('.look-card img')].slice(0, 5)
  const first = document.querySelector('.look-card')
  return {
    cards: document.querySelectorAll('.look-card').length,
    imgCount: document.querySelectorAll('.look-card img').length,
    samples: imgs.map((img) => ({
      src: (img.getAttribute('src') || '').slice(0, 90),
      complete: img.complete,
      nw: img.naturalWidth,
      visible: !!(img.offsetWidth || img.offsetHeight)
    })),
    cardBox: first ? { w: first.offsetWidth, h: first.offsetHeight } : null
  }
})
console.log(JSON.stringify(info, null, 1))
await app.process().pid && require('node:child_process').execSync(`taskkill /PID ${app.process().pid} /T /F`, { stdio: 'ignore' }).toString?.()
process.exit(0)
