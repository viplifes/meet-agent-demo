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
    Task,
    log,
    mergeFrames,
    stt,
    waitForAbort,
} from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { WebSocket } from 'ws';
import { PeriodicCollector } from './_utils';

const API_BASE_URL_V1 = 'https://api.elevenlabs.io/v1';
const AUTHORIZATION_HEADER = 'xi-api-key';

export type STTRealtimeSampleRates = 8000 | 16000 | 24000 | 44100;

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

export interface STTOptions {
    /**
     * ElevenLabs API key. Can be set via argument or ELEVEN_API_KEY environment variable.
     */
    apiKey?: string;

    /**
     * Custom base URL for the API.
     * @default 'https://api.elevenlabs.io/v1'
     */
    baseUrl?: string;

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
     * Whether to use "scribe_v2_realtime" model for streaming mode.
     * @default false
     */
    useRealtime?: boolean;

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
}

const defaultSTTOptions: Required<Omit<STTOptions, 'serverVad'>> & {
    serverVad?: VADOptions;
} = {
    apiKey: process.env.ELEVEN_API_KEY || '',
    baseUrl: API_BASE_URL_V1,
    languageCode: 'en',
    tagAudioEvents: true,
    useRealtime: false,
    sampleRate: 16000,
    includeTimestamps: false,
};

export class STT extends stt.STT {
    #opts: Required<Omit<STTOptions, 'serverVad'>> & { serverVad?: VADOptions };
    #logger = log();
    label = 'elevenlabs.STT';

    constructor(opts: STTOptions = {}) {
        const mergedOpts = { ...defaultSTTOptions, ...opts };

        super({
            streaming: mergedOpts.useRealtime,
            interimResults: mergedOpts.useRealtime,
        });

        if (!mergedOpts.apiKey) {
            throw new Error(
                'ElevenLabs API key is required, either as argument or set ELEVEN_API_KEY environment variable',
            );
        }

        if (!mergedOpts.useRealtime && opts.serverVad !== undefined) {
            this.#logger.warn('Server-side VAD is only supported for Scribe v2 realtime model');
        }

        this.#opts = mergedOpts;
    }

    get model(): string {
        return this.#opts.useRealtime ? 'Scribe v2 Realtime' : 'Scribe v1';
    }

    get provider(): string {
        return 'ElevenLabs';
    }

    updateOptions(opts: Partial<STTOptions>) {
        this.#opts = { ...this.#opts, ...opts };
    }

    async _recognize(buffer: AudioBuffer, abortSignal?: AbortSignal): Promise<stt.SpeechEvent> {
        if (this.#opts.useRealtime) {
            throw new Error('Recognize is not supported when using realtime model. Use stream() instead.');
        }

        // Convert audio buffer to WAV format
        const mergedFrame = mergeFrames(buffer);
        const wavBuffer = this.#createWav(mergedFrame);

        const formData = new FormData();
        const wavBlob = new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' });
        formData.append('file', wavBlob, 'audio.wav');
        formData.append('model_id', 'scribe_v1');
        formData.append('tag_audio_events', String(this.#opts.tagAudioEvents));

        if (this.#opts.languageCode) {
            formData.append('language_code', this.#opts.languageCode);
        }

        try {
            const response = await fetch(`${this.#opts.baseUrl}/speech-to-text`, {
                method: 'POST',
                headers: {
                    [AUTHORIZATION_HEADER]: this.#opts.apiKey,
                },
                body: formData,
                signal: abortSignal,
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(
                    `ElevenLabs API error (${response.status}): ${errorData.detail || 'Unknown error'}`,
                );
            }

            const result = await response.json();
            return this.#transcriptionToSpeechEvent(result);
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error('Request aborted');
            }
            throw error;
        }
    }

    stream(options?: { connOptions?: APIConnectOptions }): SpeechStream {
        if (!this.#opts.useRealtime) {
            throw new Error('Streaming is only supported with useRealtime: true');
        }

        return new SpeechStream(this, this.#opts, options?.connOptions);
    }

    #createWav(frame: AudioFrame): Buffer {
        const bitsPerSample = 16;
        const byteRate = (frame.sampleRate * frame.channels * bitsPerSample) / 8;
        const blockAlign = (frame.channels * bitsPerSample) / 8;

        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + frame.data.byteLength, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(frame.channels, 22);
        header.writeUInt32LE(frame.sampleRate, 24);
        header.writeUInt32LE(byteRate, 28);
        header.writeUInt16LE(blockAlign, 32);
        header.writeUInt16LE(16, 34);
        header.write('data', 36);
        header.writeUInt32LE(frame.data.byteLength, 40);

        return Buffer.concat([header, Buffer.from(frame.data.buffer)]);
    }

    #transcriptionToSpeechEvent(result: {
        text?: string;
        language_code?: string;
        words?: Array<{ text?: string; start?: number; end?: number; speaker_id?: string }>;
    }): stt.SpeechEvent {
        const text = result.text || '';
        const language = result.language_code || this.#opts.languageCode;
        const words = result.words || [];

        let startTime = 0;
        let endTime = 0;
        let speakerId: string | undefined;

        if (words.length > 0) {
            speakerId = words[0].speaker_id;
            startTime = Math.min(...words.map((w) => w.start || 0));
            endTime = Math.max(...words.map((w) => w.end || 0));
        }

        return {
            type: stt.SpeechEventType.FINAL_TRANSCRIPT,
            alternatives: [
                {
                    text,
                    language: language || '',
                    startTime,
                    endTime,
                    confidence: 1.0,
                },
            ],
        };
    }
}

export class SpeechStream extends stt.SpeechStream {
    #opts: Required<Omit<STTOptions, 'serverVad'>> & { serverVad?: VADOptions };
    #audioEnergyFilter: AudioEnergyFilter;
    #logger = log();
    #speaking = false;
    #resetWS = new Future();
    #requestId = '';
    #audioDurationCollector: PeriodicCollector<number>;
    #sessionId?: string;
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
        this.#audioDurationCollector = new PeriodicCollector(
            (duration) => this.onAudioDurationReport(duration),
            { duration: 5.0 },
        );
    }



    protected async run() {
        this.#logger.info('ElevenLabs STT stream starting...');
        const maxRetry = 32;
        let retries = 0;
        let ws: WebSocket;

        while (!this.input.closed && !this.closed) {
            try {
                this.#logger.debug('Attempting to connect to ElevenLabs WebSocket...');
                ws = await this.#connectWS();
                this.#logger.info('Successfully connected to ElevenLabs WebSocket');
                await this.#runWS(ws);
            } catch (e) {
                this.#logger.error('Error in ElevenLabs STT stream:', e);

                if (!this.closed && !this.input.closed) {
                    if (retries >= maxRetry) {
                        throw new Error(`Failed to connect to ElevenLabs after ${retries} attempts: ${e}`);
                    }

                    const delay = Math.min(retries * 5, 10);
                    retries++;

                    this.#logger.warn(
                        `Failed to connect to ElevenLabs, retrying in ${delay} seconds: ${e} (${retries}/${maxRetry})`,
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
                } else {
                    this.#logger.warn(
                        `ElevenLabs disconnected, connection is closed: ${e} (inputClosed: ${this.input.closed}, isClosed: ${this.closed})`,
                    );
                }
            }
        }

        this.closed = true;
    }

    updateOptions(opts: Partial<STTOptions>) {
        this.#opts = { ...this.#opts, ...opts };
        this.#resetWS.resolve();
    }

    async #connectWS(): Promise<WebSocket> {
        this.#logger.debug('Building WebSocket URL...');
        const commitStrategy = this.#opts.serverVad ? 'vad' : 'manual';
        const params = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            encoding: `pcm_${this.#opts.sampleRate}`,
            commit_strategy: commitStrategy,
        });

        this.#logger.info({
            model_id: 'scribe_v2_realtime',
            encoding: `pcm_${this.#opts.sampleRate}`,
            commit_strategy: commitStrategy,
            has_serverVad: !!this.#opts.serverVad,
        }, 'Connection params');

        // Add server VAD options if provided
        if (this.#opts.serverVad) {
            const vad = this.#opts.serverVad;
            this.#logger.info({ vad }, 'Adding server VAD options');
            if (vad.vadSilenceThresholdSecs !== undefined) {
                params.append('vad_silence_threshold_secs', String(vad.vadSilenceThresholdSecs));
            }
            if (vad.vadThreshold !== undefined) {
                params.append('vad_threshold', String(vad.vadThreshold));
            }
            if (vad.minSpeechDurationMs !== undefined) {
                params.append('min_speech_duration_ms', String(vad.minSpeechDurationMs));
            }
            if (vad.minSilenceDurationMs !== undefined) {
                params.append('min_silence_duration_ms', String(vad.minSilenceDurationMs));
            }
        }

        if (this.#opts.languageCode) {
            params.append('language_code', this.#opts.languageCode);
        }

        if (this.#opts.includeTimestamps) {
            params.append('include_timestamps', 'true');
        }

        // Convert HTTP URL to WSS
        const baseUrl = this.#opts.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://');
        const wsUrl = `${baseUrl}/speech-to-text/realtime?${params.toString()}`;

        const maskedUrl = wsUrl.replace(this.#opts.apiKey, '***');
        const allParams = Object.fromEntries(params.entries());

        this.#logger.info({ url: maskedUrl }, 'Full WebSocket URL');
        this.#logger.info({ params: allParams }, 'All URL params');

        return new Promise((resolve, reject) => {
            // Access private _connOptions from parent class
            const connOptions = (this as any)._connOptions as APIConnectOptions | undefined;

            const ws = new WebSocket(wsUrl, {
                headers: {
                    [AUTHORIZATION_HEADER]: this.#opts.apiKey,
                },
            });

            const timeout = setTimeout(() => {
                this.#logger.error('WebSocket connection timeout');
                ws.close();
                reject(new Error('WebSocket connection timeout'));
            }, connOptions?.timeoutMs || 10000);

            ws.on('open', () => {
                this.#logger.debug('WebSocket opened successfully');
                clearTimeout(timeout);
                resolve(ws);
            });

            ws.on('error', (error) => {
                this.#logger.error('WebSocket connection error:', error);
                clearTimeout(timeout);
                reject(error);
            });
        });
    }

    async #runWS(ws: WebSocket) {
        this.#resetWS = new Future();
        let closing = false;

        // Keepalive ping every 30 seconds
        const keepalive = setInterval(() => {
            try {
                ws.ping();
            } catch {
                clearInterval(keepalive);
            }
        }, 30000);

        const wsMonitor = Task.from(async (controller) => {
            const closed = new Promise<void>((_, reject) => {
                ws.once('close', (code, reason) => {
                    if (!closing) {
                        // Код 1000 = нормальное закрытие (например, timeout при отсутствии данных)
                        if (code === 1000) {
                            this.#logger.warn(
                                `WebSocket closed normally (code ${code}): ${reason || 'no reason'}. This usually means no audio was sent for a while.`,
                            );
                            // Возвращаем ошибку чтобы запустить retry logic
                            reject(new Error('WebSocket timeout'));
                        } else {
                            this.#logger.error(`WebSocket closed unexpectedly with code ${code}: ${reason}`);
                            reject(new Error(`WebSocket closed with code ${code}: ${reason}`));
                        }
                    } else {
                        this.#logger.info('WebSocket closed gracefully');
                    }
                });

                ws.once('error', (error) => {
                    if (!closing) {
                        this.#logger.error('WebSocket error:', error);
                        reject(error);
                    }
                });
            });

            try {
                await Promise.race([closed, waitForAbort(controller.signal)]);
            } catch (error) {
                if (!closing) {
                    this.#logger.error('WebSocket monitor caught error:', error);
                    throw error;
                }
            }
        });

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
                while (!this.closed) {
                    const result = await Promise.race([this.input.next(), abortPromise]);

                    if (result === undefined) return; // aborted
                    if (result.done) {
                        break;
                    }

                    const data = result.value;

                    let frames: AudioFrame[];
                    if (data === SpeechStream.FLUSH_SENTINEL) {
                        frames = stream.flush();
                        this.#audioDurationCollector.flush();
                    } else if (data.sampleRate === this.#opts.sampleRate && data.channels === 1) {
                        frames = stream.write(data.data.buffer as ArrayBuffer);
                    } else {
                        throw new Error(
                            `Sample rate or channel count mismatch: expected ${this.#opts.sampleRate}Hz/1ch, got ${data.sampleRate}Hz/${data.channels}ch`
                        );
                    }

                    for (const frame of frames) {
                        // if (this.#audioEnergyFilter.pushFrame(frame)) {
                        const frameDuration = frame.samplesPerChannel / frame.sampleRate;
                        this.#audioDurationCollector.push(frameDuration);
                        const audioB64 = Buffer.from(frame.data.buffer).toString('base64');
                        ws.send(
                            JSON.stringify({
                                message_type: 'input_audio_chunk',
                                audio_base_64: audioB64,
                                commit: false,
                                sample_rate: this.#opts.sampleRate,
                            }),
                        );
                        //  }
                    }
                }
            } catch (error) {
                if (!closing) {
                    this.#logger.error('Error in send task:', error);
                }
            } finally {
                this.#logger.debug('Send task finished, closing WebSocket');
                closing = true;
                wsMonitor.cancel();
            }
        };

        const listenTask = Task.from(async (controller) => {
            const putMessage = (message: stt.SpeechEvent) => {
                if (!this.queue.closed) {
                    try {
                        this.queue.put(message);
                    } catch (e) {
                        this.#logger.warn('Failed to put message in queue:', e);
                    }
                }
            };

            const listenMessage = new Promise<void>((resolve, reject) => {
                ws.on('message', (msg) => {
                    try {
                        const data = JSON.parse(msg.toString());
                        this.#logger.debug('Received message: ' + msg.toString());
                        this.#processStreamEvent(data, putMessage);

                        if (this.closed || closing) {
                            this.#logger.debug('Stream closed, resolving listen task');
                            resolve();
                        }
                    } catch (err) {
                        this.#logger.error('Error processing message:', err);
                        reject(err);
                    }
                });
            });

            try {
                await Promise.race([listenMessage, waitForAbort(controller.signal)]);
            } catch (error) {
                if (!closing) {
                    this.#logger.error('Listen task error:', error);
                    throw error;
                }
            }
        });

        await Promise.race([
            this.#resetWS.await,
            Promise.all([sendTask(), listenTask.result, wsMonitor]),
        ]);

        closing = true;
        ws.close();
        clearInterval(keepalive);
    }

    #processStreamEvent(
        data: {
            message_type?: string;
            text?: string;
            words?: Array<{ text?: string; start?: number; end?: number }>;
            session_id?: string;
            message?: string;
            details?: string;
        },
        putMessage: (message: stt.SpeechEvent) => void,
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
                this.#sessionId = data.session_id;
                this.#logger.info(`ElevenLabs session started with ID: ${this.#sessionId}`);
                break;

            case 'partial_transcript':
                this.#logger.debug({ text: text.substring(0, 50) }, 'Partial transcript');
                if (text) {
                    if (!this.#speaking) {
                        this.#logger.debug('Speech started');
                        putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                        this.#speaking = true;
                    }

                    putMessage({
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
                        putMessage({ type: stt.SpeechEventType.START_OF_SPEECH });
                        this.#speaking = true;
                    }

                    putMessage({
                        type: stt.SpeechEventType.FINAL_TRANSCRIPT,
                        alternatives: [createSpeechData()],
                    });
                } else {
                    // Empty commit signals end of speech segment
                    if (this.#speaking) {
                        this.#logger.debug('Speech ended');
                        putMessage({ type: stt.SpeechEventType.END_OF_SPEECH });
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