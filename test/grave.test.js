// Проверка формата выписки на настоящем ответе CRM (Морозовы, Домодедовское).
// Запуск: node test/grave.test.js
const {
  graveOwnerText, graveClientText, graveKeyboard, graveClientLabel, graveShown, htmlToPlain,
} = require('../api/_lib')

const BEST = {
  gid: '2807487049',
  uchastok: 'ЗИ/037/23/0996',
  cemetery: 'Домодедовское',
  cemetery_slug: 'domodedovskoe',
  matched: 'Морозов Дмитрий Иванович, 07.11.1919, 19.02.1989',
  inscription: ['Данные не читаются',
                'Морозов Дмитрий Иванович, 07.11.1919, 19.02.1989',
                'Морозова Мария Федоровна, 11.02.1926, 21.06.1992'],
  lat: 55.456405501,
  lon: 37.890458386,
  map_url: 'https://epoisk.ru/burmsk/cemetery/domodedovskoe/map/?gid=2807487049',
  score: 6,
  why: ['участок 23 — как назвал клиент', 'оба имени в одной могиле'],
}
const OTHER = {
  gid: '2807564094',
  uchastok: 'ЗИ/037/31/0926',
  cemetery: 'Домодедовское',
  inscription: ['Морозова Нина Михайловна, год 1917, год 1993',
                'Морозов Дмитрий Иванович, год 1902, год 1989'],
  lat: 55.457488564,
  lon: 37.892181135,
  map_url: 'https://epoisk.ru/burmsk/cemetery/domodedovskoe/map/?gid=2807564094',
  score: 0,
  why: [],
}

// Клиент назвал участок и второе имя — совпадение однозначное.
const SURE = {
  ok: true, fio: 'Морозов Дмитрий Иванович', cemetery: 'Домодедовское',
  total: 4, client_id: 40, photos: 0,
  results: [BEST, OTHER, { ...OTHER, gid: '2807594202' }],
}
// Клиент назвал только фамилию — выбирать не из чего, показываем всё.
const VAGUE = {
  ok: true, fio: 'Морозов Дмитрий Иванович', cemetery: 'Домодедовское',
  total: 2, results: [OTHER, { ...BEST, score: 0, why: [] }],
}

let fails = 0
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name) } else { fails++; console.log('FAIL ' + name, extra || '') }
}

const sure = graveOwnerText(SURE, 'по вашему сообщению')
check('однозначное совпадение показано ОДНО', (sure.match(/📍/g) || []).length === 1, sure)
check('участок назван словами', sure.includes('участок 23, могила 0996'))
check('код реестра всё равно виден', sure.includes('ЗИ/037/23/0996'))
check('сказано, почему именно эта могила', sure.includes('оба имени в одной могиле'))
check('остальные свёрнуты в одну строку', sure.includes('Ещё 3 по фамилии'))
check('мусорная строка выдачи убрана', !sure.includes('Данные не читаются'))
check('в шапке кладбище и источник',
  sure.startsWith('🔎 <b>Домодедовское</b>') && sure.includes('по вашему сообщению'))
check('кнопка одна, раз совпадение одно', graveShown(SURE).length === 1)

const vague = graveOwnerText(VAGUE)
check('когда выбирать не из чего — показаны все', (vague.match(/📍/g) || []).length === 2)
check('кнопок столько же, сколько строк', graveShown(VAGUE).length === 2)

check('пустой ответ -> null', graveOwnerText({ ok: true, results: [] }) === null)
check('нет ответа -> null', graveOwnerText(null) === null)

const client = graveClientText(BEST)
check('клиенту уходит вопрос, а не утверждение', client.includes('это тот самый участок?'))
check('клиенту участок назван словами', client.includes('участок 23, могила 0996'))
check('клиенту сказано, что это не подтверждение', client.includes('ещё не '))
check('клиенту не уходит «Данные не читаются»', !client.includes('Данные не читаются'))

const kb1 = graveKeyboard(graveShown(SURE), 40)
check('кнопка сразу отправляет, когда клиент известен',
  kb1.reply_markup.inline_keyboard[0][0].callback_data === 'gs:2807487049:40')
check('одна строка -> кнопка без номера участка',
  kb1.reply_markup.inline_keyboard[0][0].text === '📤 Отправить клиенту')
const kb2 = graveKeyboard(graveShown(VAGUE), null)
check('несколько строк -> в кнопке видно, какая именно',
  kb2.reply_markup.inline_keyboard[0][0].text.includes('участок 31'))
check('клиент неизвестен -> сначала спрашиваем кому',
  kb2.reply_markup.inline_keyboard[0][0].callback_data.startsWith('gc:'))
for (const row of kb2.reply_markup.inline_keyboard) {
  check('callback_data влезает в 64 байта', Buffer.byteLength(row[0].callback_data) <= 64)
  check('подпись кнопки не длиннее 60 символов', row[0].text.length <= 60, row[0].text)
}
check('пустая выдача -> нет клавиатуры', JSON.stringify(graveKeyboard([], 1)) === '{}')

const plain = htmlToPlain(client)
check('в веб-чат уходит текст без тегов', !plain.includes('<b>') && !plain.includes('</a>'))
check('ссылка в веб-чате сохранена', plain.includes('https://epoisk.ru/burmsk/cemetery/domodedovskoe/map/'))

check('карточка без имени подписана последней фразой клиента',
  graveClientLabel({ id: 40, name: null, contact: null, last_text: '925 157 48 12 Сергеева Елена',
                     web_session: 'b79c43fa-cc68-4427-aae2-078ff5f66cf0' })
    .startsWith('925 157 48 12 Сергеева Елена'))
check('карточка с именем подписана именем и кладбищем',
  graveClientLabel({ id: 2, name: 'Елова Светлана', cemetery: 'Хованское' }) === 'Елова Светлана · Хованское')

console.log(fails ? `\n${fails} проверок упало` : '\nвсе проверки прошли')
process.exit(fails ? 1 : 0)
