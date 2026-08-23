// Тест среза повторов: функции вытаскиваются из живого файла, а не копируются,
// иначе тест начнёт проходить на устаревшей копии.
const fs = require('fs')
const src = fs.readFileSync('api/chat-send.js', 'utf8')
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) throw new Error('не найдена функция ' + name)
  let d = 0, j = src.indexOf('{', i)
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1) }
  }
}
eval(['normWords', 'splitSentences', 'tooSimilar', 'dropRepeats'].map(grab).join('\n'))

const PHOTO = 'Пришлите фото ограды и участка целиком — менеджер посмотрит и назовёт точную сумму.'
const cases = [
  { name: 'дословный повтор просьбы о фото режется',
    hist: [{ role: 'ai', content: 'Здравствуйте! Покраска ограды: зачистка, грунтовка и эмаль. ' + PHOTO }],
    reply: 'Сроки зависят от размера ограды. Обычно от 1 до 3 дней. ' + PHOTO,
    want: (o) => !/Пришлите фото/.test(o) && /1 до 3 дней/.test(o) },

  { name: 'повтор с дописанным хвостом тоже режется',
    hist: [{ role: 'ai', content: PHOTO }],
    reply: 'Обычно это от 1 до 3 дней. Пришлите фото ограды и участка целиком — менеджер посмотрит и назовёт точную сумму и сроки.',
    want: (o) => !/Пришлите фото/.test(o) },

  { name: 'новая информация не режется',
    hist: [{ role: 'ai', content: PHOTO }],
    reply: 'Работаем на Бутовском кладбище. Выезд бригады в будни.',
    want: (o) => /Бутовском/.test(o) && /Выезд бригады/.test(o) },

  { name: 'пустая история — ответ не трогаем',
    hist: [], reply: PHOTO, want: (o) => o === PHOTO },

  { name: 'если вырезалось бы всё — отдаём как было',
    hist: [{ role: 'ai', content: 'Передаю менеджеру. Он ответит здесь в течение 15 минут.' }],
    reply: 'Передаю менеджеру. Он ответит здесь в течение 15 минут.',
    want: (o) => /Передаю менеджеру/.test(o) },

  { name: 'сообщения клиента не считаются сказанным нами',
    hist: [{ role: 'user', content: 'Сроки зависят от размера ограды' }],
    reply: 'Сроки зависят от размера ограды. Обычно от 1 до 3 дней.',
    want: (o) => /Сроки зависят/.test(o) },
]

let bad = 0
for (const c of cases) {
  const out = dropRepeats(c.reply, c.hist)
  const ok = c.want(out)
  if (!ok) bad++
  console.log((ok ? '  OK   ' : '  ПРОВАЛ ') + c.name)
  if (!ok) console.log('        получили: ' + out)
}
console.log('\nпройдено ' + (cases.length - bad) + ' из ' + cases.length)
process.exit(bad ? 1 : 0)
