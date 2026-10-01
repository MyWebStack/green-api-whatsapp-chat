import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ConnectionConfig } from '../src/chat/application/ports';

export const config: ConnectionConfig = {
  apiUrl: 'https://api.green-api.com',
  idInstance: '1101728000',
  apiTokenInstance: 'test-token',
};

export const settings = {
  wid: '77011234567@c.us',
  webhookUrl: '',
  incomingWebhook: 'yes',
  outgoingWebhook: 'yes',
  outgoingAPIMessageWebhook: 'yes',
  outgoingMessageWebhook: 'yes',
  stateWebhook: 'yes',
};

export const endpoint = (method: string) =>
  `${config.apiUrl}/waInstance${config.idInstance}/${method}/${config.apiTokenInstance}`;

export function notification(
  idMessage = '9001',
  text = 'Ответ из WhatsApp',
  chatId = '77011234567@c.us',
) {
  return {
    receiptId: 1,
    body: {
      typeWebhook: 'incomingMessageReceived',
      instanceData: {
        idInstance: Number(config.idInstance),
        typeInstance: 'whatsapp',
        wid: settings.wid,
      },
      idMessage,
      timestamp: 1790000000,
      senderData: { chatId, chatName: 'Анна' },
      messageData: {
        typeMessage: 'textMessage',
        textMessageData: { textMessage: text },
      },
    },
  };
}

export const server = setupServer(
  http.get(endpoint('getStateInstance'), () => HttpResponse.json({ stateInstance: 'authorized' })),
  http.get(endpoint('getSettings'), () => HttpResponse.json(settings)),
  http.get(endpoint('getWaSettings'), () =>
    HttpResponse.json({ avatar: 'https://pps.whatsapp.net/profile.jpg' }),
  ),
  http.get(endpoint('getChats'), () => HttpResponse.json([])),
  http.post(endpoint('getAvatar'), () => HttpResponse.json({ available: false, urlAvatar: '' })),
  http.post(endpoint('readChat'), () => HttpResponse.json({ setRead: true })),
  http.post(endpoint('getChatHistory'), () => HttpResponse.json([])),
  http.post(endpoint('checkWhatsapp'), () =>
    HttpResponse.json({ existsWhatsapp: true, chatId: '77011234567@c.us', username: 'Анна' }),
  ),
  http.post(endpoint('sendMessage'), () => HttpResponse.json({ idMessage: '1001' })),
  http.get(endpoint('receiveNotification'), () => HttpResponse.json(null)),
  http.delete(`${endpoint('deleteNotification')}/*`, () => HttpResponse.json({ result: true })),
);
