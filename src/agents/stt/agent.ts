import {
  type JobContext,
  AutoSubscribe,
  log
} from '@livekit/agents';
import { RoomEvent, TrackKind, TrackSource } from '@livekit/rtc-node';
import type { RemoteTrack, RemoteParticipant, RemoteTrackPublication, TrackPublication, Participant } from '@livekit/rtc-node';
import * as helper from '../../helper.js';
import { SttSession } from './session.js';
import { GetSttProvider } from '../../providers.js';
// import * as simulator from '../../simulator.js';

export default async function STTjob(ctx: JobContext) {

  const logger = log();

  await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_NONE);
  const actorId = ctx.room.name ?? "";
  const metadata = ctx.room.metadata ?? "";
  let language = helper.getCallLang(metadata, "ru");

  logger.info(`[STTjob] ${actorId} connected to room with metadata: ${metadata}`);


  const createSession = async (pub: RemoteTrackPublication, participant: Participant) => {
    if (!pub.sid || pub.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) {
      return;
    }

    const id = participant.identity;
    const prevSession = sessions[id];
    if (prevSession && prevSession.trackSid == pub.sid) {
      prevSession.restoreSession();
      logger.info(`[createSession] ${actorId} track ${id} already created for ${participant.identity} - ${participant.name}`);
      return;
    } else if (prevSession) {
      logger.info(`[createSession] ${actorId} track ${id} unsubscribed from prev ${participant.identity} - ${participant.name}`);
      pub.setSubscribed(false);
      prevSession.delayedStop(() => { });
      delete sessions[id];
    }

    const provider = GetSttProvider(language);
    logger.info(`[createSession] ${actorId} track ${id} subscribed with ${provider.label} to ${participant.identity} - ${participant.name}`);
    const session = new SttSession(ctx, actorId, pub.sid, participant, provider, (text: string) => {
      const msg = {
        userId: participant.attributes["userId"],
        date: Date.now(),
        userName: participant.info.name ?? "",
        text: text,
        type: 'user',
      };
      messages.push(msg);
      // simulator.AddTranscription(actorId, msg.userId, msg.text);
    });

    sessions[id] = session;
    await session.start();
    pub.setSubscribed(true);
  }


  const removeSession = async (pub: RemoteTrackPublication, participant: Participant) => {

    if (!pub.sid || pub.kind !== TrackKind.KIND_AUDIO || pub.source !== TrackSource.SOURCE_MICROPHONE) {
      return;
    }

    const id = participant.identity;
    const session = sessions[id];
    if (session) {
      session.delayedStop(() => {
        console.info(`[removeSession] track ${id} unsubscribed from ${participant.identity} - ${participant.name}`);
        delete sessions[id];
        pub.setSubscribed(false);
      });
    }
  }

  const messages: helper.Message[] = [];
  const sessions: Record<string, SttSession> = {};

  /// RoomMetadataChanged
  ctx.room.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
    logger.info(`[RoomEvent.RoomMetadataChanged] ${actorId} ${metadata}`);
    language = helper.getCallLang(metadata, "ru");
  });

  /// TrackSubscribed
  ctx.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    logger.info(`[RoomEvent.TrackSubscribed] ${actorId} ${participant.identity} - ${participant.name}`);
    if (!pub.muted) {
      createSession(pub, participant);
    }
  });

  /// TrackUnsubscribed
  ctx.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    logger.info(`[RoomEvent.TrackUnsubscribed] ${actorId} ${participant.identity} - ${participant.name}`);
    removeSession(pub, participant);
  });

  // microphone mute/unmute
  ctx.room.on(RoomEvent.TrackMuted, (pub: TrackPublication, participant: Participant) => {
    logger.info(`[RoomEvent.TrackMuted] ${actorId} ${participant.identity} - ${participant.name}`);
    removeSession(pub as RemoteTrackPublication, participant);
  });
  ctx.room.on(RoomEvent.TrackUnmuted, (pub: TrackPublication, participant: Participant) => {
    logger.info(`[RoomEvent.TrackUnmuted] ${actorId} ${participant.identity} - ${participant.name}`);
    createSession(pub as RemoteTrackPublication, participant);
  });


  ctx.room.on(RoomEvent.TrackPublished, (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    logger.info(`[RoomEvent.TrackPublished] ${actorId} ${participant.identity} - ${participant.name}`);
    if (!pub.muted) {
      createSession(pub, participant);
    }
  });
  ctx.room.on(RoomEvent.TrackUnpublished, (pub: RemoteTrackPublication, participant: RemoteParticipant) => {
    logger.info(`[RoomEvent.TrackUnpublished] ${actorId} ${participant.identity} - ${participant.name}`);
    removeSession(pub, participant);
  });

  /// ParticipantConnected
  ctx.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    logger.info(`[RoomEvent.ParticipantConnected] ${actorId} ${participant.identity} - ${participant.name}`);
    const msg: helper.Message = {
      userId: participant.attributes["userId"],
      date: (new Date()).getTime(),
      userName: participant.info.name!,
      text: "Participant joined",
      type: "sys",
    }
    messages.push(msg);
  });

  /// ParticipantDisconnected
  ctx.room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    logger.info(`[RoomEvent.ParticipantDisconnected] ${actorId} ${participant.identity} - ${participant.name}`);
    const msg: helper.Message = {
      userId: participant.attributes["userId"],
      date: (new Date()).getTime(),
      userName: participant.info.name!,
      text: "Participant left",
      type: "sys",
    }
    messages.push(msg);
  });

  // closed
  ctx.addShutdownCallback(async () => {
    logger.info(`[ShutdownCallback] ${actorId} closed room with ${messages.length} messages`);
    if (messages.length) {
      // await simulator.postSttJob(ctx.room.name || "", messages);
    }
    for (const session of Object.values(sessions)) {
      session.stop();
    }
  });

}