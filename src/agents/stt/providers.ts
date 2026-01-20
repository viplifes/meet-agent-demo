import { stt } from '@livekit/agents';
import config from './../../config.js';
import { STT as DeepgramStt } from '@livekit/agents-plugin-deepgram';
import * as elevenlabs from '../../plugins/elevenlabs/index.js';
import * as aws from '../../plugins/aws/index.js';


export function GetProvider(language: string): stt.STT {
  let awsConfig = config('agent.stt.aws');
  if (awsConfig) {
    return new aws.STT({
      region: config('agent.stt.aws.region') || process.env.AWS_REGION,
      accessKeyId: config('agent.stt.aws.api_key') || process.env.AWS_API_KEY,
      secretAccessKey: config('agent.stt.aws.api_secret') || process.env.AWS_API_SECRET,
      language: language,
    })
  }
  let deepgramConfig = config('agent.stt.deepgram');
  if (deepgramConfig) {
    return new DeepgramStt({
      apiKey: config('agent.stt.deepgram.api_key') || process.env.DEEPGRAM_API_KEY,
      sampleRate: 48000,
      language: language,
      detectLanguage: false,
    });
  }

  // let deepgram = config('agent.stt.deepgram');
  // if (deepgram) {
  return new elevenlabs.STT({
    apiKey: config('agent.stt.elevenlabs.api_key') || process.env.ELEVENLABS_API_KEY,
    useRealtime: true,
    languageCode: language,
    sampleRate: 16000, // Стандартный rate
    serverVad: {
      // Порог громкости (0.0 - 1.0)
      // 0.3 = чувствительный (реагирует на тихую речь)
      // 0.7 = менее чувствительный (только громкая речь)
      vadThreshold: 0.4,

      // Сколько тишины = "человек закончил"
      // 0.8 сек = быстрый ответ, но может обрезать длинные паузы
      // 2.0 сек = ждет дольше, не обрезает паузы в речи
      vadSilenceThresholdSecs: 0.8,

      // Минимальная длина речи (чтобы фильтровать шум)
      // 250мс = отсекает короткие звуки (кашель, клики)
      minSpeechDurationMs: 100,

      // Минимальная пауза между фразами
      // 2000мс = отдельные предложения не склеиваются
      minSilenceDurationMs: 100,
    }
  });
  // }
  throw "no STT provider found in config";
}
