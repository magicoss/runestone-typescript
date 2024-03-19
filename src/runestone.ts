import {
  MAX_DIVISIBILITY,
  MAX_LIMIT,
  MAX_SCRIPT_ELEMENT_SIZE,
} from './constants';
import { Edict } from './edict';
import { Etching } from './etching';
import { SeekBuffer } from './seekbuffer';
import { Tag } from './tag';
import { u128 } from './u128';
import * as bitcoin from 'bitcoinjs-lib';
import _ from 'lodash';
import { Option, Some, None, isSome } from '@sniptt/monads';
import { Rune } from './rune';
import { Flag } from './flag';

const MAX_SPACERS = 0b00000111_11111111_11111111_11111111;

type Instruction = number | Buffer;

namespace Instruction {
  export function isNumber(instruction: Instruction): instruction is number {
    return typeof instruction === 'number';
  }

  export function isBuffer(instruction: Instruction): instruction is Buffer {
    return typeof instruction !== 'number';
  }
}

export class Runestone {
  constructor(
    readonly burn: boolean,
    readonly claim: Option<u128>,
    readonly defaultOutput: Option<number>,
    readonly edicts: Edict[],
    readonly etching: Option<Etching>
  ) {}

  static fromTransaction(transaction: bitcoin.Transaction): Option<Runestone> {
    const payload = Runestone.payload(transaction);
    if (!payload) {
      return None;
    }

    const integers = Runestone.integers(payload);

    const { fields, edicts } = Message.fromIntegers(integers);

    const claim = Tag.take(fields, Tag.CLAIM);

    const deadline = Tag.take(fields, Tag.DEADLINE).andThen((value) =>
      value < 0xffff_ffffn ? Some(Number(value)) : None
    );

    const defaultOutput = Tag.take(fields, Tag.DEFAULT_OUTPUT).andThen(
      (value) => (value < 0xffff_ffffn ? Some(Number(value)) : None)
    );

    const divisibility = Tag.take(fields, Tag.DIVISIBILITY)
      .andThen((value) => (value < 0xffn ? Some(Number(value)) : None))
      .andThen((value) => (value <= MAX_DIVISIBILITY ? Some(value) : None))
      .unwrapOr(0);

    const limit = Tag.take(fields, Tag.LIMIT).map((value) =>
      value >= MAX_LIMIT ? MAX_LIMIT : value
    );

    const rune = Tag.take(fields, Tag.RUNE).map((value) => new Rune(value));

    const spacers = Tag.take(fields, Tag.SPACERS)
      .andThen<number>((value) => (value < 0xffn ? Some(Number(value)) : None))
      .andThen<number>((value) => (value <= MAX_SPACERS ? Some(value) : None))
      .unwrapOr(0);

    const symbol = Tag.take(fields, Tag.SYMBOL)
      .andThen<number>((value) =>
        value < 0xffff_ffffn ? Some(Number(value)) : None
      )
      .andThen<string>((value) => {
        try {
          return Some(String.fromCodePoint(value));
        } catch (e) {
          return None;
        }
      });

    const term = Tag.take(fields, Tag.TERM).andThen((value) =>
      value < 0xffff_ffffn ? Some(Number(value)) : None
    );

    let flags = Tag.take(fields, Tag.FLAGS).unwrapOr(u128(0));

    const etchResult = Flag.take(flags, Flag.ETCH);
    const etch = etchResult.set;
    flags = etchResult.flags;

    const mintResult = Flag.take(flags, Flag.MINT);
    const mint = mintResult.set;
    flags = mintResult.flags;

    let etching: Option<Etching> = etch
      ? Some(
          new Etching(
            divisibility,
            rune,
            spacers,
            symbol,
            mint
              ? Some({
                  deadline,
                  limit,
                  term,
                })
              : None
          )
        )
      : None;

    return Some(
      new Runestone(
        flags !== 0n ||
          [...fields.keys()].find((tag) => tag % 2n === 0n) !== undefined,
        claim,
        defaultOutput,
        edicts,
        etching
      )
    );
  }

  encipher(): Buffer {
    const payloads: Buffer[] = [];

    if (this.etching.isSome()) {
      const etching = this.etching.unwrap();
      const flags = u128(0);
      Flag.set(flags, Flag.ETCH);

      if (etching.mint.isSome()) {
        Flag.set(flags, Flag.MINT);
      }

      payloads.push(Tag.encode(Tag.FLAGS, flags));

      if (etching.rune.isSome()) {
        const rune = etching.rune.unwrap();
        payloads.push(Tag.encode(Tag.RUNE, rune.value));
      }

      if (etching.divisibility !== 0) {
        payloads.push(Tag.encode(Tag.DIVISIBILITY, u128(etching.divisibility)));
      }

      if (etching.spacers !== 0) {
        payloads.push(Tag.encode(Tag.SPACERS, u128(etching.spacers)));
      }

      if (etching.symbol.isSome()) {
        const symbol = etching.symbol.unwrap();
        payloads.push(Tag.encode(Tag.SYMBOL, u128(symbol.codePointAt(0)!)));
      }

      if (etching.mint.isSome()) {
        const mint = etching.mint.unwrap();

        if (mint.deadline.isSome()) {
          const deadline = mint.deadline.unwrap();
          payloads.push(Tag.encode(Tag.DEADLINE, u128(deadline)));
        }

        if (mint.limit.isSome()) {
          const limit = mint.limit.unwrap();
          payloads.push(Tag.encode(Tag.LIMIT, limit));
        }

        if (mint.term.isSome()) {
          const term = mint.term.unwrap();
          payloads.push(Tag.encode(Tag.TERM, u128(term)));
        }
      }
    }

    if (this.claim.isSome()) {
      const claim = this.claim.unwrap();
      payloads.push(Tag.encode(Tag.CLAIM, claim));
    }

    if (this.defaultOutput.isSome()) {
      const defaultOutput = this.defaultOutput.unwrap();
      payloads.push(Tag.encode(Tag.DEFAULT_OUTPUT, u128(defaultOutput)));
    }

    if (this.burn) {
      payloads.push(Tag.encode(Tag.BURN, u128(0)));
    }

    if (this.edicts.length) {
      payloads.push(u128.encodeVarInt(u128(Tag.BODY)));

      const edicts = _.sortBy(this.edicts, (edict) => edict.id);

      let id = u128(0);
      for (const edict of edicts) {
        payloads.push(u128.encodeVarInt(u128(edict.id - id)));
        payloads.push(u128.encodeVarInt(edict.amount));
        payloads.push(u128.encodeVarInt(edict.output));
        id = edict.id;
      }
    }

    const stack: bitcoin.Stack = [];
    stack.push(bitcoin.opcodes.OP_RETURN);
    stack.push(Buffer.from('RUNE_TEST'));

    const payload = Buffer.concat(payloads);
    let i = 0;
    for (let i = 0; i < payload.length; i += MAX_SCRIPT_ELEMENT_SIZE) {
      stack.push(payload.subarray(i, i + MAX_SCRIPT_ELEMENT_SIZE));
    }

    return bitcoin.script.compile(stack);
  }

  static payload(transaction: bitcoin.Transaction): Buffer | null {
    for (const output of transaction.outs) {
      const instructions = bitcoin.script.decompile(output.script) ?? [];
      let nextInstruction: Instruction | undefined;

      nextInstruction = instructions.shift();
      if (nextInstruction !== bitcoin.opcodes.OP_RETURN) {
        continue;
      }

      nextInstruction = instructions.shift();
      if (
        !nextInstruction ||
        Instruction.isNumber(nextInstruction) ||
        Buffer.compare(nextInstruction, Buffer.from('RUNE_TEST')) !== 0
      ) {
        continue;
      }

      let payloads: Buffer[] = [];

      for (const result of instructions) {
        if (Instruction.isBuffer(result)) {
          payloads.push(result);
        }
      }

      return Buffer.concat(payloads);
    }

    return null;
  }

  static integers(payload: Buffer): u128[] {
    const integers: u128[] = [];

    const seekBuffer = new SeekBuffer(payload);
    while (!seekBuffer.isFinished()) {
      integers.push(u128.readVarInt(seekBuffer));
    }

    return integers;
  }
}

export class Message {
  constructor(readonly fields: Map<u128, u128>, readonly edicts: Edict[]) {}

  static fromIntegers(payload: u128[]): Message {
    const edicts: Edict[] = [];
    const fields = new Map<u128, u128>();

    for (const i of _.range(0, payload.length, 2)) {
      const tag = payload[i];

      if (u128(Tag.BODY) === tag) {
        let id = u128(0);
        for (const chunk of _.chunk(payload.slice(i + 1), 3)) {
          if (chunk.length !== 3) {
            break;
          }

          id = u128.saturatingAdd(id, chunk[0]);
          edicts.push({
            id,
            amount: chunk[1],
            output: chunk[2],
          });
        }
        break;
      }

      const value = payload[i + 1];
      if (value === undefined) {
        break;
      }

      if (!fields.has(tag)) {
        fields.set(tag, value);
      }
    }

    return new Message(fields, edicts);
  }
}
