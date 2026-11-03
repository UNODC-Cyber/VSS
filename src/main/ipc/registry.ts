/**
 * IPC registry. Lanes implement handlers (one per `VssApi` method) and pass them to `registerIpc`.
 * Missing handlers answer `NOT_SUPPORTED`. Every request is validated with its zod schema and the sender frame must be
 * the vss://app origin (or the dev server when unpackaged).
 */
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { ALL_CHANNELS, parseChannel } from '@shared/ipc/channels';
import type { ChannelName, Namespace } from '@shared/ipc/channels';
import type { Result, VssApi } from '@shared/ipc/contract';
import { err } from '@shared/ipc/result';
import { ipcSchemas, schemasForChannel } from '@shared/ipc/schemas';
import { APP_ORIGIN, devRendererUrl } from '../bootstrap/security';

type ArgOf<F> = F extends () => unknown ? undefined : F extends (arg: infer A) => unknown ? A : never;
type ResultOf<F> = F extends (...args: never[]) => infer P ? P : never;

/** Handler for method M of namespace N: same argument as the API method, may return Result or throw. */
export type Handler<N extends Exclude<keyof VssApi, 'on'>, M extends keyof VssApi[N]> = (
  arg: ArgOf<VssApi[N][M]>,
  event: IpcMainInvokeEvent,
) => ResultOf<VssApi[N][M]>;

export type Handlers = {
  [N in Exclude<keyof VssApi, 'on'>]?: { [M in keyof VssApi[N]]?: Handler<N, M> };
};

export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? '';
  const dev = devRendererUrl();
  return url.startsWith(`${APP_ORIGIN}/`) || (dev !== null && url.startsWith(dev));
}

export async function dispatch(
  channel: string,
  rawArg: unknown,
  event: IpcMainInvokeEvent,
  handlers: Handlers,
): Promise<Result<unknown>> {
  if (!isTrustedSender(event)) return err('UNTRUSTED_SENDER', 'Untrusted sender');
  const parsed = parseChannel(channel);
  const schemas = schemasForChannel(channel);
  if (!parsed || !schemas) return err('BAD_REQUEST', 'Unknown channel');
  const checked = schemas.req.safeParse(rawArg);
  if (!checked.success) {
    const first = checked.error.issues[0];
    return err('BAD_REQUEST', `Invalid request${first ? `: ${first.path.join('.')} ${first.message}` : ''}`);
  }
  const [ns, method] = parsed;
  const handler = (handlers[ns as Exclude<Namespace, never>] as Record<string, unknown> | undefined)?.[method] as
    ((arg: unknown, e: IpcMainInvokeEvent) => Promise<Result<unknown>> | Result<unknown>) | undefined;
  if (!handler) return err('NOT_SUPPORTED', `${channel} is not implemented`);
  try {
    return await handler(checked.data, event);
  } catch (e) {
    // Never leak messages that could contain personal data.
    void e;
    return err('INTERNAL', 'Internal error');
  }
}

let registered = false;
export function registerIpc(handlers: Handlers): void {
  if (registered) throw new Error('registerIpc called twice');
  registered = true;
  for (const channel of ALL_CHANNELS) {
    ipcMain.handle(channel, (event, arg: unknown) => dispatch(channel, arg, event, handlers));
  }
}

export type { ChannelName };
export { ipcSchemas };
