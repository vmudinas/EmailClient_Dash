declare module "node-mbox" {
  import type { Readable, Transform, TransformOptions, Writable } from "node:stream";

  export class Mbox extends Transform {
    constructor(options?: TransformOptions & { includeMboxHeader?: boolean });
    messageCount: number;
  }

  export function MboxStream(
    input: Readable,
    options?: TransformOptions & { includeMboxHeader?: boolean }
  ): Mbox;

  export class MboxStreamConsumer extends Writable {}
}

