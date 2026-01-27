import {
  type JobContext,
  voice,
  stt,
  log,
} from '@livekit/agents';
import type { Participant } from '@livekit/rtc-node';
import * as silero from '@livekit/agents-plugin-silero';


export class SttSession {
  #logger = log();

  private ctx: JobContext;
  public actorId: string;
  public trackSid: string;
  private participant: Participant;
  private onTranscript: (text: string) => void;
  //
  private session: voice.AgentSession;
  private agent: voice.Agent;
  private stopTimer?: NodeJS.Timeout;

  constructor(ctx: JobContext, actorId: string, trackSid: string, participant: Participant, stt: stt.STT, onTranscript: (text: string) => void) {
    this.ctx = ctx;
    this.actorId = actorId;
    this.trackSid = trackSid;
    this.participant = participant;
    this.onTranscript = onTranscript;
    this.session = new voice.AgentSession({});

    let vad;
    if (stt.label == "openai.STT") {
      vad = ctx.proc.userData.vad as silero.VAD;
    }

    this.agent = new voice.Agent({
      vad: vad,
      instructions: "",
      stt: stt,
    });

  }

  async start() {
    const agent = this.agent;
    await this.session.start({
      agent,
      room: this.ctx.room,
      inputOptions: {
        audioEnabled: true,
        videoEnabled: false,
        textEnabled: false,
        participantIdentity: this.participant.identity,
      },
      outputOptions: {
        transcriptionEnabled: true,
        audioEnabled: false,
      },
    });

    this.session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) {
        this.#logger.info(`[UserInputTranscribed FULL] ${this.actorId} ${this.participant.identity} - ${this.participant.name}`);
        this.onTranscript(ev.transcript);
      } else {
        this.#logger.info(`[UserInputTranscribed PART] ${this.actorId} ${this.participant.identity} - ${this.participant.name}`);
      }
    });

  }


  async restoreSession() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
    }
  }


  async delayedStop(callback: () => void) {
    this.stopTimer = setTimeout(async () => {
      callback();
      await this.stop();
    }, 5000);
  }

  async stop() {
    await this.session.close();
    this.session.removeAllListeners();
  }

}
