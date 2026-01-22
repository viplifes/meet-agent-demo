import { stt } from '@livekit/agents';
import config from './config.js';
import * as openai from '@livekit/agents-plugin-openai';
import * as deepgram from './plugins/deepgram/index.js';
import * as elevenlabs from './plugins/elevenlabs/index.js';
import * as aws from './plugins/aws/index.js';


export function GetSttProvider(language: string): stt.STT {

  const provider = process.env.STT_PROVIDER;

  // aws
  let awsConfig = config('agent.stt.aws');
  if (awsConfig || provider == "aws") {
    return new aws.STT({
      region: config('agent.stt.aws.region') || process.env.AWS_REGION,
      accessKeyId: config('agent.stt.aws.api_key') || process.env.AWS_API_KEY,
      secretAccessKey: config('agent.stt.aws.api_secret') || process.env.AWS_API_SECRET,
      language: language,
    })
  }

  // deepgram
  let deepgramConfig = config('agent.stt.deepgram');
  if (deepgramConfig || provider == "deepgram") {
    return new deepgram.STT({
      apiKey: config('agent.stt.deepgram.api_key') || process.env.DEEPGRAM_API_KEY,
      sampleRate: 48000,
      language: language,
      detectLanguage: false,
    });
  }

  // elevenlabs
  let elevenlabsConfig = config('agent.stt.elevenlabs');
  if (elevenlabsConfig || provider == "elevenlabs") {
    return new elevenlabs.STT({
      apiKey: config('agent.stt.elevenlabs.api_key') || process.env.ELEVENLABS_API_KEY,
      languageCode: language,
    });
  }

  // openai
  let openaiConfig = config('agent.stt.openai');
  if (openaiConfig || provider == "openai") {
    return new openai.STT({
      apiKey: config('agent.stt.openai.api_key') || process.env.OPENAI_API_KEY,
      language: language,
    })
  }


  throw "no STT provider found in config";
}
