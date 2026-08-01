// Проверка форматирования выписки на настоящем ответе CRM (Морозовы, Домодедовское).
// Запуск: node test/grave.test.js
const {
  graveOwnerText, graveClientText, graveKeyboard, graveClientLabel, htmlToPlain,
} = require('../api/_lib')

const G = {
  ok: true,
  fio: 'Морозов Дмитрий Иванович',
  cemetery: 'Домодедовское',
  total: 4,
  client_id: 40,
  photos: 0,
  results: [{
    gid: '2807487049',
    uchastok: 'ЗИ/037/23/0996',
    cemetery: 'Домодедовское',
    cemetery_slug: 'domodedovskoe',
    matched: 'Морозов Дмитрий Иванович, 07.11.1919, 19.02.1989',
    inscription: ['Морозов Дмитрий Иванович, 07.11.1919, 19.02.1989',
                  'Морозова Мария Федоровна, 11.02.1926, 21.06.1992'],
    lat: 55.456405501,
    lon: 37.890458386,
    map_url: 'https://epoisk.ru/burmsk/cemetery/domodedovskoe/map/?gid=2807487049',
  }],
}

let fails = 0
function check(name, cond, extra) {
  if (cond) { console.log('ok   ' + name) } else { fails++; console.log('FAIL ' + name, extra || '') }
}

const owner = graveOwnerText(G, 'по вашему сообщению')
check('выписка владельцу содержит участок', owner.includes('ЗИ/037/23/0996'))
check('выписка называет источник', owner.includes('по вашему сообщению'))
check('в выписке есть обе надписи', owner.includes('Мария Федоровна'))
check('пустой ответ -> null', graveOwnerText({ ok: true, results: [] }) === null)
check('нет ответа -> null', graveOwnerText(null) === null)

const client = graveClientText(G.results[0])
check('клиенту уходит вопрос, а не утверждение', client.includes('это тот самый участок?'))
check('клиенту сказано, что это не подтверждение', client.includes('ещё не '))
check('в тексте клиенту есть план участка', client.includes('epoisk.ru'))

const kb1 = graveKeyboard(G.results, 40)
check('кнопка сразу отправляет, когда клиент известен',
  kb1.reply_markup.inline_keyboard[0][0].callback_data === 'gs:2807487049:40')
const kb2 = graveKeyboard(G.results, null)
check('кнопка сначала спрашивает кому, когда клиент неизвестен',
  kb2.reply_markup.inline_keyboard[0][0].callback_data === 'gc:2807487049')
const cd = kb1.reply_markup.inline_keyboard[0][0].callback_data
check('callback_data влезает в 64 байта', Buffer.byteLength(cd) <= 64, cd)
const btn = kb1.reply_markup.inline_keyboard[0][0].text
check('подпись кнопки не длиннее 60 символов', btn.length <= 60, btn)
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
