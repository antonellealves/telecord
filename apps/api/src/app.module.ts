import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuthGuard } from './auth/auth.guard';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { ConfigModule } from './common/config.module';
import { HttpErrorFilter } from './common/http-error.filter';
import { IceModule } from './ice/ice.module';
import { LiveKitModule } from './livekit/livekit.module';
import { LoggingModule } from './logging/logging.module';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { PeersModule } from './peers/peers.module';
import { RoomsModule } from './rooms/rooms.module';
import { SoundsModule } from './sounds/sounds.module';
import { UsersModule } from './users/users.module';

/*
 * A ordem em `APP_GUARD` é a ordem de execução: o limitador vem antes da
 * autenticação. Invertido, uma enxurrada de requisições sem token pagaria a
 * verificação de assinatura antes de ser barrada — que é o trabalho caro.
 */
@Module({
  imports: [
    ConfigModule,
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    LoggingModule,
    MailModule,
    AuthModule,
    UsersModule,
    PeersModule,
    RoomsModule,
    ChannelsModule,
    SoundsModule,
    LiveKitModule,
    IceModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: HttpErrorFilter },
  ],
})
export class AppModule {}
