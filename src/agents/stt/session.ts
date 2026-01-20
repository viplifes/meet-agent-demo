import {
  type JobContext,
  voice,
  stt,
} from '@livekit/agents';
import type { RemoteParticipant } from '@livekit/rtc-node';


export class SttSession {
  private ctx: JobContext;
  private participant: RemoteParticipant;
  private onTranscript: (text: string) => void;
  //
  private session: voice.AgentSession;
  private agent: voice.Agent;

  constructor(ctx: JobContext, participant: RemoteParticipant, stt: stt.STT, onTranscript: (text: string) => void) {
    this.ctx = ctx;
    this.participant = participant;
    this.onTranscript = onTranscript;
    this.session = new voice.AgentSession({});
    this.agent = new voice.Agent({
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
        this.onTranscript(ev.transcript);
      }
      console.log(`${this.participant.identity} -> isFinal=${ev.isFinal} transcript=${ev.transcript}`);
    });
  }

  async stop() {
    await this.session.close();
  }
}
