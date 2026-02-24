import type { Server } from 'socket.io';
import type { Logger } from 'pino';
import { GameService } from './service/game-service';

export const attachSocketHandlers = (io: Server, gameService: GameService, logger: Logger): void => {
  io.on('connection', (socket) => {
    logger.info({ socketId: socket.id }, 'socket connected');

    socket.on('v1:room.create', (payload) => {
      void gameService.createRoom(socket, payload).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:room.join', (payload) => {
      void gameService.joinRoom(socket, payload).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:room.leave', () => {
      void gameService.leaveRoom(socket).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:lobby.ready', (payload) => {
      void gameService.setReady(socket, payload).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:lobby.start', () => {
      void gameService.startGame(socket).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:game.flip', (payload) => {
      void gameService.flip(socket, payload).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:game.stop', () => {
      void gameService.stopGame(socket).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:game.slap', (payload) => {
      void gameService.slap(socket, payload).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('v1:ping', (payload) => {
      void gameService.ping(socket, payload).catch((error: unknown) => {
        gameService.handleFailure(socket, error);
      });
    });

    socket.on('disconnect', () => {
      void gameService.handleDisconnect(socket).catch((error: unknown) => {
        logger.error({ error, socketId: socket.id }, 'disconnect handling failed');
      });
    });
  });
};
