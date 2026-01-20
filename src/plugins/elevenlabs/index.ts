// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * ElevenLabs Plugin for LiveKit Agents
 * 
 * This plugin provides Speech-to-Text (STT) functionality using ElevenLabs Scribe API.
 * 
 * @example
 * ```typescript
 * import { STT } from '@livekit/agents-plugin-elevenlabs';
 * 
 * // Batch transcription (Scribe v1)
 * const stt = new STT({
 *   apiKey: 'your-api-key',
 *   languageCode: 'en',
 * });
 * 
 * // Streaming transcription (Scribe v2 Realtime)
 * const streamingStt = new STT({
 *   apiKey: 'your-api-key',
 *   languageCode: 'en',
 *   useRealtime: true,
 *   includeTimestamps: true,
 *   serverVad: {
 *     vadSilenceThresholdSecs: 1.5,
 *     vadThreshold: 0.4,
 *   },
 * });
 * 
 * const stream = streamingStt.stream();
 * for await (const event of stream) {
 *   console.log(event);
 * }
 * ```
 * 
 * @module @livekit/agents-plugin-elevenlabs
 */

export { STT, SpeechStream, type STTOptions, type VADOptions } from './stt';
export { type STTModels, type STTLanguages, type STTRealtimeSampleRates } from './models';