const OWNER_CHAT_ID = 696698928
const BOT_TOKEN = process.env.BOT_TOKEN

async function sendMessage(chatId, text, options = {}) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...options }),
  })
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('OK')

  const { message } = req.body || {}
  if (!message) return res.status(200).send('OK')

  const chatId = message.chat.id
  const text = message.text || ''
  const from = message.from
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ')

  // Владелец отвечает на пересланное сообщение → отправляем клиенту
  if (chatId === OWNER_CHAT_ID && message.reply_to_message) {
    const original = message.reply_to_message.text || ''
    const match = original.match(/chat_id: (\d+)/)
    if (match) {
      const customerChatId = parseInt(match[1])
      await sendMessage(customerChatId, `💬 *Менеджер УходМогил:*\n${text}`)
      await sendMessage(OWNER_CHAT_ID, '✅ Ответ отправлен клиенту')
    }
    return res.status(200).send('OK')
  }

  // Сообщение от клиента
  if (chatId !== OWNER_CHAT_ID) {
    // Команда /start
    if (text === '/start') {
      await sendMessage(chatId,
        '🌿 *Добро пожаловать в УходМогил!*\n\n' +
        'Мы занимаемся профессиональной уборкой и уходом за могилами на кладбищах Москвы.\n\n' +
        '✅ Фотоотчёт до и после\n' +
        '✅ Выезд 1–3 дня\n' +
        '✅ Цены от 3 500 ₽\n\n' +
        'Напишите нам — на каком кладбище нужна уборка и что сделать. Ответим быстро!\n\n' +
        '🌐 Сайт: https://uhod-mogil.ru'
      )
    } else {
      // Автоответ клиенту
      await sendMessage(chatId,
        '👋 Сообщение получено! Менеджер ответит вам в ближайшее время.\n\n' +
        'Также можете оставить заявку на сайте: https://uhod-mogil.ru'
      )
    }

    // Пересылаем владельцу
    await sendMessage(OWNER_CHAT_ID,
      `📨 *Новое сообщение от клиента*\n\n` +
      `👤 Имя: ${name}\n` +
      (from.username ? `📎 @${from.username}\n` : '') +
      `💬 Сообщение: ${text}\n\n` +
      `chat_id: ${chatId}\n\n` +
      `↩️ _Нажми "Ответить" на это сообщение чтобы написать клиенту_`
    )
  }

  res.status(200).send('OK')
}
