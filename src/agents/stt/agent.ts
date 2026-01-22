import {
  type JobContext,
  type JobProcess,
  defineAgent,
} from '@livekit/agents';
import { RoomEvent, TrackKind } from '@livekit/rtc-node';
import type { RemoteTrack, RemoteParticipant, RemoteTrackPublication } from '@livekit/rtc-node';
import * as silero from '@livekit/agents-plugin-silero';
import * as helper from '../../helper.js';
import { SttSession } from './session.js';
import { GetSttProvider } from '../../providers.js';

export default defineAgent({

  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await silero.VAD.load();
  },

  entry: async (ctx: JobContext) => {

    await ctx.connect();
    const actorId = ctx.room.name ?? "";
    const metadata = ctx.room.metadata ?? "";
    let language = helper.getCallLang(metadata, "ru");

    console.info(`[stt ${actorId}] connected to room with metadata: ${metadata}`);

    const messages: helper.Message[] = [];
    const sessions: Record<string, SttSession> = {};

    /// RoomMetadataChanged
    ctx.room.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
      console.info(`[stt ${actorId}] RoomMetadataChanged ${metadata}`);
      language = helper.getCallLang(metadata, "ru");
    });

    /// TrackSubscribed
    ctx.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track && track.kind === TrackKind.KIND_AUDIO) {
        const id = track.sid || participant.identity;
        const provider = GetSttProvider(language);
        console.info(`[stt ${actorId}] track ${id} subscribed with ${provider.label} to ${participant.name} ${JSON.stringify(participant.attributes)}`);
        const session = new SttSession(ctx, participant, provider, (text: string) => {
          messages.push({
            userId: participant.attributes["userId"],
            date: Date.now(),
            userName: participant.info.name ?? "",
            text: text,
            type: 'user',
          }
          );
        });
        sessions[id] = session;
        session.start();
      }
    });

    /// TrackUnsubscribed
    ctx.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      const id = track.sid || participant.identity;
      const session = sessions[id];
      if (session) {
        console.info(`[stt ${actorId}] track ${id} unsubscribed from ${participant.name}`);
        session.stop();
        delete sessions[id];
      }
    });

    /// ParticipantConnected
    ctx.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      const msg: helper.Message = {
        userId: participant.attributes["userId"],
        date: (new Date()).getTime(),
        userName: participant.info.name!,
        text: "Participant joined",
        type: "sys",
      }
      messages.push(msg);
      console.info(`[stt ${actorId}] ${helper.msgToText(msg, true)}`);
    });

    /// ParticipantDisconnected
    ctx.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      const msg: helper.Message = {
        userId: participant.attributes["userId"],
        date: (new Date()).getTime(),
        userName: participant.info.name!,
        text: "Participant left",
        type: "sys",
      }
      messages.push(msg);
      console.info(`[stt ${actorId}] ${helper.msgToText(msg, true)}`);
    });

    // closed
    ctx.addShutdownCallback(async () => {
      console.info(`[stt ${actorId}] closed room with ${messages.length} messages`);
      if (messages.length) {
        //   await helper.postSttJob(ctx.room.name || "", messages);
      }
      for (const session of Object.values(sessions)) {
        session.stop();
      }
    });

  },
});