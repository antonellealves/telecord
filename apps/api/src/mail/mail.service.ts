import { Inject, Injectable, Logger } from '@nestjs/common';
import { CONFIG, type AppConfig } from '../common/config';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Envio de e-mail com dois modos.
 *
 * `log` é o padrão e serve o desenvolvimento local: em vez de mandar, escreve a
 * mensagem inteira no log do processo — com o link de verificação clicável no
 * `docker compose logs`. Sem isso, testar cadastro localmente exigiria conta
 * num provedor antes de escrever a primeira linha.
 *
 * `resend` fala HTTP direto, sem SDK. É uma requisição só; a biblioteca
 * acrescentaria uma dependência para montar um JSON.
 *
 * Falha de envio NUNCA derruba a operação que a disparou: cadastro que grava o
 * usuário e depois estoura porque o provedor de e-mail está fora deixaria a
 * pessoa sem conta e sem explicação. Registra e segue; reenviar é rota própria.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('MailService');

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  async send(mail: Mail): Promise<void> {
    try {
      if (this.config.mailDriver === 'log') {
        this.logger.log(`\n--- e-mail para ${mail.to} ---\n${mail.subject}\n\n${mail.text}\n---`);
        return;
      }
      await this.sendWithResend(mail);
    } catch (error) {
      this.logger.error(
        `falha ao enviar "${mail.subject}"`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async sendWithResend(mail: Mail): Promise<void> {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.resendApiKey ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.config.mailFrom,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend respondeu HTTP ${response.status}`);
    }
  }
}
