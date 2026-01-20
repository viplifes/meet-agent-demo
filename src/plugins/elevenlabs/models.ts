// SPDX-FileCopyrightText: 2024 LiveKit, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Supported sample rates for ElevenLabs STT Realtime API
 */
export type STTRealtimeSampleRates = 8000 | 16000 | 24000 | 44100;

/**
 * ElevenLabs STT Models
 */
export type STTModels = 'scribe_v1' | 'scribe_v2_realtime';

/**
 * Common language codes supported by ElevenLabs STT
 */
export type STTLanguages =
    | 'en' // English
    | 'es' // Spanish
    | 'fr' // French
    | 'de' // German
    | 'it' // Italian
    | 'pt' // Portuguese
    | 'pl' // Polish
    | 'nl' // Dutch
    | 'ja' // Japanese
    | 'zh' // Chinese
    | 'ko' // Korean
    | 'ar' // Arabic
    | 'ru' // Russian
    | 'tr' // Turkish
    | 'hi' // Hindi
    | 'sv' // Swedish
    | 'da' // Danish
    | 'no' // Norwegian
    | 'fi' // Finnish
    | 'cs' // Czech
    | 'ro' // Romanian
    | 'uk' // Ukrainian
    | 'el' // Greek
    | 'bg' // Bulgarian
    | 'hr' // Croatian
    | 'sk' // Slovak
    | 'ta' // Tamil
    | 'id' // Indonesian
    | 'ms' // Malay
    | 'vi' // Vietnamese
    | 'th'; // Thai