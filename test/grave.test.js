// Проверка формата выписки на настоящем ответе CRM (Морозовы, Домодедовское).
// Запуск: node test/grave.test.js
const {
  graveOwnerText, graveClientText, graveKeyboard, graveClientLabel, graveShown, htmlToPlain,
  graveCopyText, graveConfirmKeyboard, looksLikeGraveText,
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
  card_url: 'https://epoisk.ru/burmsk/?gid=2807487049',
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
  card_url: 'https://epoisk.ru/burmsk/?gid=2807564094',
  score: 0,
  why: [],
}
const THIRD = { ...OTHER, gid: '2807594202', uchastok: 'ЗИ/037/84/0373' }
const FOURTH = { ...OTHER, gid: '2807513001', uchastok: 'ЗИ/037/94/1103' }

// Клиент назвал участок и второе имя — первый вариант сошёлся с его текстом.
const SURE = {
  ok: true, fio: 'Морозов Дмитрий Иванович', cemetery: 'Домодедовское',
  total: 4, client_id: 40, photos: 0,
  results: [BEST, OTHER, THIRD, FOURTH],
}
// Клиент назвал только фамилию — выбирать не из чего, но показать надо всё.
const VAGUE = {
  ok: true, fio: 'Морозов Дмитрий Иванович', cemetery: 'Домодедовское',
  total: 2, results: [OTHER, { ...BEST, score: 0, why: [] }],
}
const CLIENT = { id: 40, name: null, contact: null, last_text: '925 157 48 12 Сергеева Елена',
                 web_session: 'b79c43fa-cc68-4427-aae2-078ff5f66cf0' }

let fails = 0
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name) } else { fails++; console.log('FAIL ' + name, extra || '') }
}

// По чему вообще полезем в реестр, когда владелец пишет свободный текст.
for (const [t, want] of [
  ['Троекуровское, Иванов Иван Иванович 1937', true],
  ['Домодедовское кладбище, участок 23, Морозов Дмитрий', true],
  ['на Хованском лежит бабушка, Петрова Анна', true],
  ['Привет, что по заказу Еловой?', false],
  ['Завтра выезд в 10, оплату получил', false],
  ['Московский район, приеду завтра', false],
  ['кладбище', false],
]) {
  check('триггер: ' + (want ? 'ищем' : 'молчим') + ' — ' + t.slice(0, 32),
    looksLikeGraveText(t) === want)
}

const sure = graveOwnerText(SURE, 'по вашему сообщению')
check('карточкой развёрнут тот вариант, что сошёлся с текстом', sure.indexOf('участок 23, могила 0996') < sure.indexOf('уч. 31'))
check('код реестра всё равно виден', sure.includes('ЗИ/037/23/0996'))
check('сказано, почему именно эта могила', sure.includes('оба имени в одной могиле'))
check('остальные варианты перечислены, а не скрыты',
  sure.includes('уч. 31, мог. 0926') && sure.includes('уч. 84, мог. 0373') && sure.includes('уч. 94, мог. 1103'))
check('у вариантов есть номера для кнопок', sure.includes('2️⃣') && sure.includes('4️⃣'))
check('мусорная строка выдачи убрана', !sure.includes('Данные не читаются'))
check('в шапке кладбище и источник',
  sure.startsWith('🔎 <b>Домодедовское</b>') && sure.includes('по вашему сообщению'))
check('в карточке есть маршрут и карточка реестра (там бывает фото)',
  sure.includes('>маршрут<') && sure.includes('>карточка в реестре<'))

const vague = graveOwnerText(VAGUE)
check('без явного фаворита показаны все', vague.includes('уч. 23, мог. 0996') || vague.includes('участок 23'))
check('пустой ответ -> null', graveOwnerText({ ok: true, results: [] }) === null)
check('нет ответа -> null', graveOwnerText(null) === null)

// Сотня однофамильцев не должна ни разорвать сообщение, ни забить экран кнопками.
const HUGE = {
  ok: true, cemetery: 'Домодедовское', total: 1000,
  results: Array.from({ length: 1000 }, (_, i) => ({
    ...OTHER, gid: String(3000000000 + i), uchastok: `ЗИ/037/${i}/000${i}`,
  })),
}
const huge = graveOwnerText(HUGE)
check('на тысяче совпадений сообщение влезает в лимит телеграма', huge.length < 4000, huge.length)
check('на тысяче совпадений показано не больше восьми', graveShown(HUGE).length === 8)
check('сказано, что показаны не все', huge.includes('Всего совпадений 1000'))
const hugeKb = graveKeyboard(HUGE, 40).reply_markup.inline_keyboard
check('кнопок остаётся немного', hugeKb.reduce((n, row) => n + row.length, 0) <= 12,
  hugeKb.reduce((n, row) => n + row.length, 0))

const client = graveClientText(BEST)
check('клиенту уходит вопрос, а не утверждение', client.includes('это тот самый участок?'))
check('клиенту участок назван словами', client.includes('участок 23, могила 0996'))
check('клиенту сказано, что это не подтверждение', client.includes('ещё не '))
check('клиенту не уходит «Данные не читаются»', !client.includes('Данные не читаются'))

const copy = graveCopyText(BEST)
check('текст для клиента копируется одним нажатием', /<code>[^<]*участок 23, могила 0996/.test(copy))
check('в копии нет html-тегов внутри блока', !/<code>[^<]*<b>/.test(copy))
check('для мастера отдельный короткий блок', copy.includes('🔧 <b>Мастеру</b>') && copy.includes('координаты 55.456'))

const kb = graveKeyboard(SURE, 40).reply_markup.inline_keyboard
check('первая строка — скопировать и отправить',
  kb[0][0].callback_data === 'gt:2807487049' && kb[0][1].callback_data === 'gs:2807487049:40')
check('вторая строка — номера остальных вариантов',
  kb[1][0].callback_data === 'gp:2807564094:40' && kb[1].length === 3)
const kbNoClient = graveKeyboard(SURE, null).reply_markup.inline_keyboard
check('клиент неизвестен -> сначала спрашиваем кому',
  kbNoClient[0][1].callback_data === 'gc:2807487049')

const conf = graveConfirmKeyboard(BEST, CLIENT).inline_keyboard
check('подтверждение показывает и участок, и кому',
  conf[0][0].text.includes('уч. 23') && conf[0][0].text.includes('Сергеева'))
check('отправляет только вторая кнопка', conf[1][0].callback_data === 'gy:2807487049:40')
check('есть отмена', conf[1][1].callback_data === 'gx:2807487049:40')
for (const row of [...kb, ...conf]) {
  for (const b of row) {
    check('callback_data влезает в 64 байта', Buffer.byteLength(b.callback_data) <= 64, b.callback_data)
    check('подпись кнопки не длиннее 60 символов', b.text.length <= 60, b.text)
  }
}
check('пустая выдача -> нет клавиатуры', JSON.stringify(graveKeyboard([], 1)) === '{}')

const plain = htmlToPlain(client)
check('в веб-чат уходит текст без тегов', !plain.includes('<b>') && !plain.includes('</a>'))
check('ссылка в веб-чате сохранена', plain.includes('https://epoisk.ru/burmsk/cemetery/domodedovskoe/map/'))

check('карточка без имени подписана последней фразой клиента',
  graveClientLabel(CLIENT).startsWith('925 157 48 12 Сергеева Елена'))
check('карточка с именем подписана именем и кладбищем',
  graveClientLabel({ id: 2, name: 'Елова Светлана', cemetery: 'Хованское' }) === 'Елова Светлана · Хованское')

console.log(fails ? `\n${fails} проверок упало` : '\nвсе проверки прошли')
process.exit(fails ? 1 : 0)
