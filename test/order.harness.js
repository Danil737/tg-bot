// Офлайн-проверка ветки «владелец переслал → заказ» в webhook.js.
// Стабим global.fetch (его же использует fetchWithTimeout), CRM и Telegram не трогаем.
process.env.OWNER_CHAT_ID = '696698928'
process.env.BOT_TOKEN = 'TESTTOKEN'
process.env.CRM_URL = 'http://127.0.0.1:9410'
process.env.CRM_SECRET = 'x'
process.env.TG_WEBHOOK_SECRET = 'sek'

const OWNER = 696698928
let calls = []
let orderResponder = () => ({ ok: true, client_id: 501, created: true })

global.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : null
  calls.push({ url, body })
  if (String(url).includes('/api/bot/order')) {
    return { ok: true, status: 200, json: async () => orderResponder(body) }
  }
  if (String(url).includes('/sendMessage')) {
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) }
  }
  // grave-поиск и прочее — нейтральный ответ
  return { ok: true, status: 200, json: async () => ({ ok: false, need: 'fio' }), text: async () => '' }
}

const handler = require('../api/webhook.js')

function makeRes() {
  return { _code: 0, status(c) { this._code = c; return this }, send() { return this } }
}
async function run(message, { secret = 'sek' } = {}) {
  calls = []
  const req = { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, query: {}, body: { message } }
  await handler(req, makeRes())
  return calls
}
const orderCalls = () => calls.filter(c => c.url.includes('/api/bot/order'))
const sendCalls = () => calls.filter(c => c.url.includes('/sendMessage'))
let pass = 0, fail = 0
function ok(cond, name) { if (cond) { pass++; console.log('  OK  ' + name) } else { fail++; console.log('FAIL  ' + name) } }

;(async () => {
  // 1) Пересылка с фото и подписью → заказ + ссылка
  await run({
    message_id: 10, chat: { id: OWNER }, from: { id: OWNER, first_name: 'Daniil' },
    forward_origin: { type: 'user' }, photo: [{ file_id: 'F1' }],
    caption: 'Уборка на Ваганьковском, участок 5',
  })
  ok(orderCalls().length === 1, '1. пересылка+фото: 1 вызов /api/bot/order')
  ok(orderCalls()[0].body.text.includes('Ваганьков'), '1. текст подписи ушёл в заказ')
  ok(orderCalls()[0].body.media_ref === 'F1', '1. file_id фото в media_ref')
  ok(sendCalls().length === 1 && /Заказ создан/.test(sendCalls()[0].body.text) && sendCalls()[0].body.text.includes('#c501'),
     '1. ответ владельцу со ссылкой #c501')

  // 2) Альбом: два фото, одна группа. CRM: первое created=true, второе created=false.
  //    Ссылка должна уйти РОВНО один раз.
  let first = true
  orderResponder = () => { const r = first ? { ok: true, client_id: 777, created: true } : { ok: true, client_id: 777, created: false }; first = false; return r }
  let sends = 0
  for (const [i, cap] of [[0, ''], [1, 'Памятник Троекуровское, замена']]) {
    await run({
      message_id: 20 + i, chat: { id: OWNER }, from: { id: OWNER, first_name: 'Daniil' },
      forward_origin: { type: 'user' }, media_group_id: 'G777', photo: [{ file_id: 'A' + i }],
      caption: cap,
    })
    sends += sendCalls().length
  }
  ok(sends === 1, '2. альбом из 2 фото: ответ-ссылка ровно один раз')
  orderResponder = () => ({ ok: true, client_id: 501, created: true })

  // 3) /zakaz текст (скопирован из вацапа, метки пересылки нет) → заказ
  await run({
    message_id: 30, chat: { id: OWNER }, from: { id: OWNER, first_name: 'Daniil' },
    text: '/zakaz Ограда на Хованском, демонтаж и установка новой',
  })
  ok(orderCalls().length === 1, '3. /zakaz: заказ создан')
  ok(!orderCalls()[0].body.text.startsWith('/zakaz') && orderCalls()[0].body.text.includes('Хованск'),
     '3. /zakaz: префикс срезан, текст сохранён')

  // 4) Пересылка от НЕ владельца → ветка не срабатывает (нет вызова /api/bot/order)
  await run({
    message_id: 40, chat: { id: 111222 }, from: { id: 111222, first_name: 'X' },
    forward_origin: { type: 'user' }, text: 'что-то',
  })
  ok(orderCalls().length === 0, '4. не-владелец: заказ НЕ создаётся')

  // 5) Обычный grave-текст владельца (без пересылки/вложения/zakaz) → НЕ заказ
  await run({
    message_id: 50, chat: { id: OWNER }, from: { id: OWNER, first_name: 'Daniil' },
    text: 'Домодедовское кладбище, Иванов Пётр Сергеевич',
  })
  ok(orderCalls().length === 0, '5. простой текст владельца: заказ НЕ создаётся (идёт в /mogila-путь)')

  // 6) Ответ владельца на уведомление с фото → это ответ клиенту, НЕ заказ
  await run({
    message_id: 60, chat: { id: OWNER }, from: { id: OWNER, first_name: 'Daniil' },
    reply_to_message: { message_id: 5, text: 'chatid: 999' }, photo: [{ file_id: 'R1' }],
  })
  ok(orderCalls().length === 0, '6. reply с фото: не заказ (это ответ клиенту)')

  console.log('\nИТОГ: ' + pass + ' из ' + (pass + fail))
  process.exit(fail ? 1 : 0)
})()
