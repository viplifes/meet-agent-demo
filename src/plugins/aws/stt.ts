import {
    type AudioBuffer,
    AudioByteStream,
    AudioEnergyFilter,
    stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

import {
    BadRequestException,
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand,
    LanguageCode,
    StartStreamTranscriptionCommandOutput,
    TranscribeStreamingClientConfig
} from '@aws-sdk/client-transcribe-streaming';

const SAMPLE_RATE = 48000;

function normalizeLocale(langCode: string): string {
    const mapping: Record<string, string> = {
        zh: "zh-CN",
        da: "da-DK",
        nl: "nl-NL",
        en: "en-US",
        fr: "fr-FR",
        de: "de-DE",
        hi: "hi-IN",
        pt: "pt-BR",
        es: "es-ES",
        it: "it-IT",
        ja: "ja-JP",
        ko: "ko-KR",
        no: "no-NO",
        pl: "pl-PL",
        sv: "sv-SE",
        ta: "ta-IN",
        uk: "uk-UA",
        tr: "tr-TR",
        id: "id-ID",
        ru: "ru-RU",
        th: "th-TH",
    };

    return mapping[langCode] ?? "";
}


export interface STTOptions {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    language: string;
    logstr?: string;
}

export class STT extends stt.STT {
    private config: STTOptions;
    readonly label = 'aws.STT';
    /**
     * Create a new instance of AWS Transcribe STT.
     */
    constructor(options: STTOptions = { language: 'en-US' }) {
        super({ streaming: true, interimResults: true });
        let language = normalizeLocale(options.language);
        if (!language) {
            language = 'en-US'
        }
        options.language = language;
        this.config = options;
    }

    /**
     * Close the STT service and clean up resources
     */
    async close(): Promise<void> { }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
        throw new Error('Recognize is not supported on Deepgram STT');
    }

    /**
     * Create a streaming speech recognition session
     */
    stream(): SpeechStream {
        return new SpeechStream(this, this.config);
    }
}



class SpeechStream extends stt.SpeechStream {
    private config: STTOptions;
    private audioStream?: AsyncGenerator<{ AudioEvent: { AudioChunk: Buffer } }>;
    private client: TranscribeStreamingClient;
    label = 'aws.SpeechStream';

    /**
     * Create a new streaming speech recognition session
     */
    constructor(stt: STT, config: STTOptions) {
        super(stt);
        this.config = config;

        const ops: TranscribeStreamingClientConfig = {
            region: config.region,
        }
        if (config.accessKeyId != null && config.secretAccessKey != null) {
            ops.credentials = {
                accessKeyId: config.accessKeyId!,
                secretAccessKey: config.secretAccessKey!,
            };
        }

        // client
        this.client = new TranscribeStreamingClient(ops);
        this.run();
    }
    /**
     * Run the streaming recognition loop
     */
    async run(): Promise<void> {

        this.log(`start TranscribeStreamingClient`);
        try {

            const command = new StartStreamTranscriptionCommand({
                LanguageCode: this.config.language as LanguageCode,
                MediaEncoding: "pcm",
                MediaSampleRateHertz: SAMPLE_RATE,
                AudioStream: this._getAudioStream(),
            });

            const response: StartStreamTranscriptionCommandOutput = await this.client.send(command);
            for await (const event of response.TranscriptResultStream!) {
                const results = event.TranscriptEvent?.Transcript?.Results;
                for (const result of results ?? []) {
                    if (this.queue.closed) {
                        return;
                    }

                    const isFinal = !result.IsPartial;
                    const text = result.Alternatives?.[0]?.Transcript ?? '';
                    const eventType = isFinal
                        ? stt.SpeechEventType.FINAL_TRANSCRIPT
                        : stt.SpeechEventType.INTERIM_TRANSCRIPT;

                    this.queue.put({
                        type: eventType,
                        alternatives: [{
                            text,
                            language: this.config.language,
                            startTime: 0,
                            endTime: 0,
                            confidence: 0,
                        }],
                    });
                    // console.log(`text: ${text}`);
                    if (!result.IsPartial) {
                        this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
                    }
                }
            }

        } catch (e) {
            this._handleError(e);
        }
    }

    private _getAudioStream(): AsyncGenerator<{ AudioEvent: { AudioChunk: Buffer } }> {
        const self = this;
        const audioEnergyFilter = new AudioEnergyFilter();
        const samples100Ms = Math.floor(100 / 1000 * SAMPLE_RATE * 2);
        const stream = new AudioByteStream(SAMPLE_RATE, 1, samples100Ms);
        this.audioStream = (async function* () {
            for await (const data of self.input) {
                let frames: AudioFrame[];
                if (data === SpeechStream.FLUSH_SENTINEL) {
                    frames = stream.flush();
                } else if (data.sampleRate === SAMPLE_RATE || data.channels === 1) {
                    frames = stream.write(data.data.buffer as ArrayBuffer);
                } else {
                    throw new Error(`sample rate or channel count of frame does not match`);
                }

                for await (const frame of frames) {
                    if (audioEnergyFilter.pushFrame(frame)) {
                        yield { AudioEvent: { AudioChunk: int16ArrayToPCM(frame.data) } };
                    }
                }
            }
        })();
        return this.audioStream;
    }

    async _handleError(e: any): Promise<void> {
        if (e instanceof BadRequestException) {
            if (e.message.indexOf('no new audio was received') > -1) {
                this.log("disconnected: no new audio was received, wait new audio input");
                await this.audioStream?.return?.(0);
                this.log("try reconnect");
                this.run();
                return;
            }
        } else {
            this.log("transcription error:" + e.message + ", stack:" + e.stack);
            await new Promise(r => setTimeout(r, 5000));
            await this.audioStream?.return?.(0);
            this.log("try reconnect");
            this.run();
        }
    }

    log(str: string): void {
        console.info(`[aws ${this.config.logstr ?? ''}] ${str}`);
    }

}



function int16ArrayToPCM(int16Data: Int16Array): Buffer {
    // Create a buffer with the same byte length as the Int16Array
    // Each Int16 value uses 2 bytes
    const buffer = Buffer.alloc(int16Data.length * 2);
    // Write each Int16 value to the buffer in little-endian format
    for (let i = 0; i < int16Data.length; i++) {
        buffer.writeInt16LE(int16Data[i], i * 2);
    }
    return buffer;
}