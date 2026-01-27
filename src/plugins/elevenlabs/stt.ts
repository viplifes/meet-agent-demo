// Keepalive ping every 30 seconds
// const keepalive// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
import {
    type APIConnectOptions,
    type AudioBuffer,
    AudioByteStream,
    AudioEnergyFilter,
    Future,
    log,
    stt,
    waitForAbort,
} from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
const API_BASE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const AUTHORIZATION_HEADER = 'xi-api-key';

export type STTRealtimeSampleRates = 8000 | 16000 | 24000 | 44100;

export interface STTOptions {
    /**
     * ElevenLabs API key. Can be set via argument or ELEVEN_API_KEY environment variable.
     */
    apiKey?: string;

    /**
     * Language code for the STT model (e.g., 'en', 'es', 'fr').
     */
    languageCode?: string;

    /**
     * Whether to tag audio events like (laughter), (footsteps), etc. in the transcription.
     * Only supported for Scribe v1 model.
     * @default true
     */
    tagAudioEvents?: boolean;

    /**
     * Audio sample rate in Hz.
     * @default 16000
     */
    sampleRate?: STTRealtimeSampleRates;

    /**
     * Server-side VAD options. Only supported for Scribe v2 realtime model.
     */
    serverVad?: VADOptions;

    /**
     * Whether to include word-level timestamps in the transcription.
     * @default false
     */
    includeTimestamps?: boolean;

    logKey?: string;

}


export interface VADOptions {
    /**
     * Silence threshold in seconds for VAD.
     * @default 1.5
     */
    vadSilenceThresholdSecs?: number;

    /**
     * Threshold for voice activity detection.
     * @default 0.4
     */
    vadThreshold?: number;

    /**
     * Minimum speech duration in milliseconds.
     * @default 250
     */
    minSpeechDurationMs?: number;

    /**
     * Minimum silence duration in milliseconds.
     * @default 2500
     */
    minSilenceDurationMs?: number;
}


const defaultSTTOptions: Required<Omit<STTOptions, 'serverVad'>> & {
    serverVad?: VADOptions;
} = {
    apiKey: process.env.ELEVEN_API_KEY || '',
    languageCode: 'en',
    tagAudioEvents: true,
    sampleRate: 16000,
    includeTimestamps: false,
    logKey: "",
    // serverVad: {
    //     vadThreshold: 0.2,
    //     vadSilenceThresholdSecs: 0.3,
    // },
};

export class STT extends stt.STT {
    #opts: Required<Omit<STTOptions, 'serverVad'>> & { serverVad?: VADOptions };
    label = 'elevenlabs.STT';
    private abortController = new AbortController();

    constructor(opts: STTOptions = {}) {
        const mergedOpts = { ...defaultSTTOptions, ...opts };

        super({
            streaming: true,
            interimResults: true,
        });

        if (!mergedOpts.apiKey) {
            throw new Error(
                'ElevenLabs API key is required, either as argument or set ELEVEN_API_KEY environment variable',
            );
        }
        this.#opts = mergedOpts;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async _recognize(_: AudioBuffer): Promise<stt.SpeechEvent> {
        throw new Error('Recognize is not supported on STT');
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

export class SpeechStream extends stt.SpeechStream {
    #opts: Required<Omit<STTOptions, 'serverVad'>> & { serverVad?: VADOptions };
    #audioEnergyFilter: AudioEnergyFilter;
    #logger = log();
    #speaking = false;
    #resetWS = new Future();
    #requestId = '';
    label = 'elevenlabs.SpeechStream';

    constructor(
        stt: STT,
        opts: Required<Omit<STTOptions, 'serverVad'>> & { serverVad?: VADOptions },
        connOptions?: APIConnectOptions,
    ) {
        super(stt, opts.sampleRate, connOptions);
        this.#opts = opts;
        this.closed = false;
        this.#audioEnergyFilter = new AudioEnergyFilter();
    }


    private _createWs(): WebSocket {
        const streamURL = new URL(API_BASE_URL);
        const params = {
            model_id: 'scribe_v2_realtime',
            encoding: `pcm_${this.#opts.sampleRate}`,
            commit_strategy: 'manual', // vad || manual
            vad_silence_threshold_secs: this.#opts.serverVad?.vadSilenceThresholdSecs,
            vad_threshold: this.#opts.serverVad?.vadThreshold,
            minSpeechDurationMs: this.#opts.serverVad?.minSpeechDurationMs,
            minSilenceDurationMs: this.#opts.serverVad?.minSilenceDurationMs,
            language_code: this.#opts.languageCode,
            include_timestamps: this.#opts.includeTimestamps,
        };
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined) {
                if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
                    streamURL.searchParams.append(k, encodeURIComponent(v));
                } else {
                    //  v.forEach((x) => streamURL.searchParams.append(k, encodeURIComponent(x)));
                }
            }
        });

        this.#logger.info(`[elevenlabs.STT] ${this.#opts.logKey} building WebSocket URL: ${streamURL}`);
        return new WebSocket(streamURL, {
            headers: {
                [AUTHORIZATION_HEADER]: this.#opts.apiKey,
            },
        })
    }

    protected async run() {
        const retryDelaysMs = [0, 100, 300, 500, 800, 1000, 2000];
        const maxRetry = 10032;
        let retries = 0;

        while (!this.input.closed && !this.closed) {
            let ws = this._createWs();
            try {

                await new Promise((resolve, reject) => {
                    ws.on('open', resolve);
                    ws.on('error', (error) => reject(error));
                    ws.on('close', (code) => reject(`WebSocket returned ${code}`));
                });

                ws.on('message', (msg) => {
                    try {
                        const data = JSON.parse(msg.toString());
                        this.#logger.debug(`[elevenlabs.STT] ${this.#opts.logKey} received message: ${msg.toString()}`);
                        this.#processStreamEvent(data);
                    } catch (err) {
                        this.#logger.error('Error processing message:', err);
                    }
                });

                await this.#runWS(ws);

            } catch (e) {

                if (!this.closed && !this.input.closed) {
                    if (retries >= maxRetry) {
                        throw new Error(`failed to connect to websocket after ${retries} attempts: ${e}`);
                    }
                    const delayMs = retryDelaysMs[Math.min(retries, retryDelaysMs.length - 1)];
                    retries++;

                    this.#logger.warn(
                        `[elevenlabs.STT] ${this.#opts.logKey} failed to connect to websocket, retrying in ${delayMs}ms: ${e} (${retries}/${maxRetry})`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                } else {
                    this.#logger.info(
                        `[elevenlabs.STT] ${this.#opts.logKey} websocket disconnected, connection is closed (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
                    );
                }

            } finally {
                ws.close();
                ws.removeAllListeners();
            }

        }

        this.closed = true;
    }

    updateOptions(opts: Partial<STTOptions>) {
        this.#opts = { ...this.#opts, ...opts };
        this.#resetWS.resolve();
    }

    async #runWS(ws: WebSocket) {

        let closing = false;
        var flushTimeout: NodeJS.Timeout;


        // Keepalive ping every 10 seconds
        const keepalive = setInterval(() => {
            try {
                ws.ping();
            } catch {
                closing = true;
                clearInterval(keepalive);
            }
        }, 10000);


        // WSS monitor
        ws.once('close', (code, reason) => {
            if (!closing) {
                this.#logger.error(`[elevenlabs.STT] ${this.#opts.logKey} WebSocket closed with code ${code}: ${reason}`);
            }
            closing = true;
        });

        // WSS send data
        const sendTask = async () => {

            const samples100Ms = Math.floor(this.#opts.sampleRate / 10);
            const stream = new AudioByteStream(
                this.#opts.sampleRate,
                1,
                samples100Ms,
            );

            // waitForAbort internally sets up an abort listener on the abort signal
            // we need to put it outside loop to avoid constant re-registration of the listener
            const abortPromise = waitForAbort(this.abortSignal);

            try {
                while (!this.closed && !closing) {
                    const result = await Promise.race([this.input.next(), abortPromise]);

                    if (!result) {
                        break;
                    }

                    if (result.done) {
                        break;
                    }

                    const data = result.value;

                    let frames: AudioFrame[];
                    const isFlush = data === SpeechStream.FLUSH_SENTINEL
                    if (isFlush) {
                        frames = stream.flush();
                        // this.#audioDurationCollector.flush();
                    } else if (data.sampleRate === this.#opts.sampleRate && data.channels === 1) {
                        frames = stream.write(data.data.buffer as ArrayBuffer);
                    } else {
                        throw new Error(
                            `Sample rate or channel count mismatch: expected ${this.#opts.sampleRate}Hz/1ch, got ${data.sampleRate}Hz/${data.channels}ch`
                        );
                    }

                    let sended = false;
                    for (const frame of frames) {
                        if (isFlush || this.#audioEnergyFilter.pushFrame(frame)) {
                            sended = isFlush ? false : true;
                            // const frameDuration = frame.samplesPerChannel / frame.sampleRate;
                            // this.#audioDurationCollector.push(frameDuration);
                            const audioB64 = Buffer.from(frame.data.buffer).toString('base64');
                            ws.send(
                                JSON.stringify({
                                    message_type: 'input_audio_chunk',
                                    audio_base_64: audioB64,
                                    commit: isFlush,
                                    sample_rate: this.#opts.sampleRate,
                                }),
                            );

                        }
                    }
                    if (sended) {
                        if (flushTimeout) {
                            clearTimeout(flushTimeout);
                        }
                        flushTimeout = setTimeout(() => {
                            if (!closing) {
                                this.#logger.info(`[elevenlabs.STT] ${this.#opts.logKey} FLUSH`);
                                this.flush();
                            }
                        }, 400);
                    }

                }
            } catch (error) {
                if (!closing) {
                    this.#logger.error('Error in send task:', error);
                }
            } finally {
                this.#logger.debug(`[elevenlabs.STT] ${this.#opts.logKey} send task finished, closing WebSocket`);
                closing = true;
            }
        };


        try {
            await Promise.race([
                sendTask(),
                waitForAbort(this.abortController.signal),
            ]);
        } finally {
            closing = true;
            ws.close();
        }

        throw 'stop runWS'

    }

    #processStreamEvent(
        data: {
            message_type?: string;
            text?: string;
            words?: Array<{ text?: string; start?: number; end?: number }>;
            session_id?: string;
            message?: string;
            details?: string;
        }
    ) {
        const messageType = data.message_type;
        const text = data.text || '';
        const words = data.words || [];

        this.#logger.debug({
            messageType,
            textLength: text.length,
            wordsCount: words.length
        }, 'Processing stream event');

        let startTime = 0;
        let endTime = 0;

        if (words.length > 0) {
            startTime = Math.min(...words.map((w) => w.start || 0));
            endTime = Math.max(...words.map((w) => w.end || 0));
        }

        const createSpeechData = (): stt.SpeechData => ({
            language: this.#opts.languageCode || 'en',
            text,
            startTime,
            endTime,
            confidence: 1.0,
        });

        switch (messageType) {
            case 'session_started':
                break;

            case 'partial_transcript':
                this.#logger.debug({ text: text.substring(0, 50) }, 'Partial transcript');
                if (text) {
                    if (!this.#speaking) {
                        this.#logger.debug('Speech started');
                        this.putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                        this.#speaking = true;
                    }

                    this.putMessage({
                        type: stt.SpeechEventType.INTERIM_TRANSCRIPT,
                        alternatives: [createSpeechData()],
                    });
                }
                break;

            case 'committed_transcript':
            case 'committed_transcript_with_timestamps':
                this.#logger.debug({ text: text.substring(0, 50) }, 'Committed transcript');
                if (text) {
                    if (!this.#speaking) {
                        this.#logger.debug('Speech started (from committed)');
                        this.putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                        this.#speaking = true;
                    }

                    this.putMessage({
                        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                        alternatives: [createSpeechData()],
                    });
                } else {
                    // Empty commit signals end of speech segment
                    if (this.#speaking) {
                        this.#logger.debug('Speech ended');
                        this.putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
                        this.#speaking = false;
                    }
                }
                break;

            case 'auth_error':
            case 'quota_exceeded':
            case 'transcriber_error':
            case 'input_error':
            case 'error':
                const errorMsg = data.message || 'Unknown error';
                const details = data.details ? ` - ${data.details}` : '';
                this.#logger.error({ messageType, errorMsg, details }, 'ElevenLabs STT error');
                throw new Error(`${messageType}: ${errorMsg}${details}`);

            case 'invalid_request':
                const invalidMsg = data.message || 'Invalid request';
                const invalidDetails = data.details ? ` - ${data.details}` : '';
                this.#logger.error({ invalidMsg, invalidDetails }, 'ElevenLabs invalid request');
                this.#logger.error({ data }, 'Full error data');
                throw new Error(`Invalid request: ${invalidMsg}${invalidDetails}`);

            default:
                this.#logger.warn(`Unknown message type: ${messageType}`, data);
                break;
        }
    }

    private putMessage(message: stt.SpeechEvent) {
        if (!this.queue.closed) {
            try {
                this.queue.put(message);
            } catch (e) {
                this.#logger.warn('Failed to put message in queue:', e);
            }
        }
    };


}