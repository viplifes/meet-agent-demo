export interface Message {
  userId: string;
  date: number;
  userName: string;
  text: string;
  type: string;
}

export function getCallLang(metadata: string, defaultLang: string): string {
  let language = defaultLang || 'ru';
  try {
    let json = JSON.parse(metadata ?? "{}");
    if (json && json.transcriptionLang) {
      language = json.transcriptionLang;
    }
  } catch (e) { }
  return language;
}


export const msgToText = function (msg: Message, withText: boolean): string {
  if (msg.type === 'sys') {
    return `[${toDate(msg.date)}] System Event: ${msg.text} - ${msg.userName} (ID: ${msg.userId})\n`;
  } else if (withText) {
    return `[${toDate(msg.date)}] ${msg.userName} (ID: ${msg.userId}): ${msg.text}\n`;
  } else {
    return `[${toDate(msg.date)}] ${msg.userName} (ID: ${msg.userId})\n`;
  }
}


export function toDate(timeMs: number, format?: string): string {
  format = format || "YYYY.MM.DD HH:II:SS";
  const date = new Date(timeMs);
  const padZero = (num: number, length: number = 2): string => num.toString().padStart(length, '0');

  const components: Record<string, string> = {
    YYYY: date.getFullYear().toString(),
    MM: padZero(date.getMonth() + 1),
    DD: padZero(date.getDate()),
    HH: padZero(date.getHours()),
    II: padZero(date.getMinutes()),
    SS: padZero(date.getSeconds())
  };

  return format.replace(/YYYY|MM|DD|HH|II|SS/g, match => components[match]);
}