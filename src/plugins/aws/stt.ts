import {
    type APIConnectOptions,
    type AudioBuffer,
    AudioByteStream,
    AudioEnergyFilter,
    log,
    stt,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';

import {
    BadRequestException,
    TranscribeStreamingClient,
    StartStreamTranscriptionCommand,
    LanguageCode,
    type StartStreamTranscriptionCommandOutput,
    type TranscribeStreamingClientConfig
} from '@aws-sdk/client-transcribe-streaming';
import { PeriodicCollector } from './_utils.js';


export type STTRealtimeSampleRates = 16000;
const SAMPLE_RATE = 16000;

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
    /**
     * Audio sample rate in Hz.
     * @default 48000
     */
    sampleRate?: STTRealtimeSampleRates;
}

export class STT extends stt.STT {

    #opts: STTOptions;
    #logger = log();
    label = 'aws.STT';
    private abortController = new AbortController();

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
        this.#opts = options;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
        throw new Error('Recognize is not supported on Deepgram STT');
    }

    updateOptions(opts: Partial<STTOptions>) {
        this.#opts = { ...this.#opts, ...opts };
    }

    stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
        return new SpeechStream(this, this.#opts, options?.connOptions);
    }

    async close() {
        this.abortController.abort();
    }
}


class SpeechStream extends stt.SpeechStream {
    #opts: STTOptions;
    #audioEnergyFilter: AudioEnergyFilter;
    #logger = log();
    #speaking = false;
    #requestId = '';
    #audioDurationCollector: PeriodicCollector<number>;
    label = 'aws.SpeechStream';

    private audioStream: AsyncGenerator<{ AudioEvent: { AudioChunk: Buffer } }> | null = null;
    private client: TranscribeStreamingClient;
    private currentStreamAbortController: AbortController | null = null;

    constructor(stt: STT, opts: STTOptions, connOptions?: APIConnectOptions) {
        super(stt, opts.sampleRate, connOptions);
        this.#opts = opts;
        this.closed = false;
        this.#audioEnergyFilter = new AudioEnergyFilter();
        this.#audioDurationCollector = new PeriodicCollector(
            (duration) => this.onAudioDurationReport(duration),
            { duration: 5.0 },
        );

        const ops: TranscribeStreamingClientConfig = {
            region: this.#opts.region,
        }
        if (this.#opts.accessKeyId != null && this.#opts.secretAccessKey != null) {
            ops.credentials = {
                accessKeyId: this.#opts.accessKeyId!,
                secretAccessKey: this.#opts.secretAccessKey!,
            };
        }

        this.client = new TranscribeStreamingClient(ops);
    }

    protected async run() {
        const retryDelaysMs = [0, 100, 300, 500, 800, 1000, 2000];
        const maxRetry = 10032;
        let retries = 0;

        while (!this.input.closed && !this.closed) {
            this.log(`start TranscribeStreamingClient`);

            try {
                const command = new StartStreamTranscriptionCommand({
                    LanguageCode: this.#opts.language as LanguageCode,
                    MediaEncoding: "pcm",
                    MediaSampleRateHertz: SAMPLE_RATE,
                    AudioStream: this._getAudioStream(),
                });

                const response: StartStreamTranscriptionCommandOutput =
                    await this.client.send(command);

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
                                language: this.#opts.language,
                                startTime: 0,
                                endTime: 0,
                                confidence: 0,
                            }],
                        });

                        if (!result.IsPartial) {
                            this.queue.put({ type: stt.SpeechEventType.END_OF_SPEECH });
                        }
                    }
                }

                // Успешное завершение - сбрасываем счетчик ретраев
                retries = 0;

            } catch (e) {
                // Завершаем текущий стрим перед переподключением
                await this._closeCurrentAudioStream();

                if (!this.closed && !this.input.closed) {
                    if (retries >= maxRetry) {
                        throw new Error(
                            `failed to connect to websocket after ${retries} attempts: ${e}`
                        );
                    }

                    const delayMs = retryDelaysMs[
                        Math.min(retries, retryDelaysMs.length - 1)
                    ];
                    retries++;

                    this.#logger.warn(
                        `failed to connect to websocket, retrying in ${delayMs}ms: ${e} ` +
                        `(${retries}/${maxRetry})`
                    );

                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                } else {
                    this.#logger.warn(
                        `websocket disconnected, connection is closed: ${e} ` +
                        `(inputClosed: ${this.input.closed}, isClosed: ${this.closed})`
                    );
                }
            } finally {
                this.log("finish connection attempt");
            }
        }

        await this._closeCurrentAudioStream();
        this.closed = true;
    }

    private async _closeCurrentAudioStream(): Promise<void> {
        if (this.currentStreamAbortController) {
            this.currentStreamAbortController.abort();
            this.currentStreamAbortController = null;
        }

        if (this.audioStream) {
            try {
                await this.audioStream.return?.(undefined);
            } catch (e) {
                this.#logger.debug(`Error closing audio stream: ${e}`);
            }
            this.audioStream = null;
        }
    }

    private _getAudioStream(): AsyncGenerator<{ AudioEvent: { AudioChunk: Buffer } }> {
        // Создаем новый AbortController для этого стрима
        this.currentStreamAbortController = new AbortController();
        const abortSignal = this.currentStreamAbortController.signal;

        const audioEnergyFilter = new AudioEnergyFilter();
        const self = this;
        const samples100Ms = Math.floor(SAMPLE_RATE / 10);
        const stream = new AudioByteStream(SAMPLE_RATE, 1, samples100Ms);

        this.audioStream = (async function* () {
            try {
                for await (const data of self.input) {
                    // Проверяем, не был ли стрим отменен
                    if (abortSignal.aborted) {
                        self.log('Audio stream aborted');
                        return;
                    }

                    let frames: AudioFrame[];
                    if (data === SpeechStream.FLUSH_SENTINEL) {
                        frames = stream.flush();
                    } else if (data.sampleRate === SAMPLE_RATE || data.channels === 1) {
                        frames = stream.write(data.data.buffer as ArrayBuffer);
                    } else {
                        throw new Error(
                            `sample rate or channel count of frame does not match`
                        );
                    }

                    for (const frame of frames) {
                        if (abortSignal.aborted) {
                            return;
                        }

                        if (audioEnergyFilter.pushFrame(frame)) {
                            yield { AudioEvent: { AudioChunk: int16ArrayToPCM(frame.data) } };
                        }
                    }
                }
            } catch (e) {
                if (!abortSignal.aborted) {
                    self.#logger.error(`Error in audio stream: ${e}`);
                    throw e;
                }
            } finally {
                self.log('Audio stream generator finished');
            }
        })();

        return this.audioStream;
    }

    log(str: string): void {
        console.info(`[aws ${this.#opts.logstr ?? ''}] ${str}`);
    }

    private onAudioDurationReport(duration: number) {
        const usageEvent: stt.SpeechEvent = {
            type: stt.SpeechEventType.RECOGNITION_USAGE,
            requestId: this.#requestId,
            recognitionUsage: {
                audioDuration: duration,
            },
        };
        this.queue.put(usageEvent);
    }
}

function int16ArrayToPCM(int16Data: Int16Array): Buffer {
    const buffer = Buffer.alloc(int16Data.length * 2);
    for (let i = 0; i < int16Data.length; i++) {
        buffer.writeInt16LE(int16Data[i], i * 2);
    }
    return buffer;
}