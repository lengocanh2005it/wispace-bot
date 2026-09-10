export interface ZaloOutboundTransportInput {
  recipientId: string;
  text: string;
  accessToken: string;
  signal?: AbortSignal;
}

export interface ZaloOutboundTransportResult {
  ok: boolean;
  status: number;
  statusText: string;
  responseBody: string;
  applicationError: number;
}

export interface ZaloOutboundTransportPort {
  sendText(
    input: ZaloOutboundTransportInput,
  ): Promise<ZaloOutboundTransportResult>;
}

export const ZALO_OUTBOUND_TRANSPORT = Symbol('ZALO_OUTBOUND_TRANSPORT');
