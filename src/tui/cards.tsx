/**
 * The Ink components: one per card, each laying out its view-model and nothing more.
 *
 * There is deliberately almost nothing here, and that is the story's own design note: each card is a pure
 * function producing a title and lines, so a component's whole job is to place those strings in a layout.
 * Any logic that crept in here could only be tested by rendering a terminal, while the same logic in a
 * view-model is tested by calling a function — which is why story 1-9 ended with thirty-one pure tests and
 * exactly one rendered frame, and why its two injected mutations were caught by the pure ones.
 *
 * The components are per-card rather than one generic renderer because a card is a *kind of message*, and
 * R5 asks for a stable grammar a person pattern-matches rather than reads. Today every kind is drawn the
 * same way — a headline and its lines, wrapped to the terminal — so each one delegates to {@link CardFrame}
 * instead of repeating it. When one card earns a layout of its own, it changes here and no view-model moves.
 *
 * No colour, by the same rule the shell follows: nothing here sets one, so a terminal without colour
 * support draws exactly what a terminal with it does.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

import { DEFAULT_COLUMNS, wrapLine } from './app.js';
import { cardLines } from './cards/index.js';
import type {
  BriefCard,
  Card,
  CardBody,
  CompletionCard,
  HandoffCard,
  KillCard,
  QuestionCard,
  SpecEchoCard,
} from './cards/index.js';

export interface CardProps<TCard extends CardBody> {
  readonly card: TCard;
  readonly columns?: number;
}

/**
 * A card's lines, wrapped to the terminal and drawn in order.
 *
 * Wrapping rather than truncating, for the reason the shell wraps: 40 columns is a declared state, and a
 * line cut in half loses whichever half mattered — including, at the wrong moment, the half naming the
 * branch a person's work is on.
 */
export const CardFrame = ({ card, columns }: CardProps<CardBody>): ReactNode => (
  <Box flexDirection="column">
    {cardLines(card)
      .flatMap((line) => wrapLine(line, columns ?? DEFAULT_COLUMNS))
      .map((line, index) => (
        <Text key={`${card.kind}-${String(index)}-${line}`}>{line}</Text>
      ))}
  </Box>
);

/** The one-question card (Q1–Q3): prompt, brief, options with consequences, default and window. */
export const QuestionCardView = ({ card, columns }: CardProps<QuestionCard>): ReactNode => (
  <CardFrame card={card} {...(columns === undefined ? {} : { columns })} />
);

/** The spec echo (CAP-2): numbered criteria, confirmable in one keystroke, editable by line. */
export const SpecEchoCardView = ({ card, columns }: CardProps<SpecEchoCard>): ReactNode => (
  <CardFrame card={card} {...(columns === undefined ? {} : { columns })} />
);

/** The morning brief (CAP-22): every in-flight feature, bounded by the terminal height. */
export const BriefCardView = ({ card, columns }: CardProps<BriefCard>): ReactNode => (
  <CardFrame card={card} {...(columns === undefined ? {} : { columns })} />
);

/** The kill card (R11): usage and elapsed against estimate, with the four gestures. */
export const KillCardView = ({ card, columns }: CardProps<KillCard>): ReactNode => (
  <CardFrame card={card} {...(columns === undefined ? {} : { columns })} />
);

/** The completion notice (R8): what was verified, and what was not. */
export const CompletionCardView = ({ card, columns }: CardProps<CompletionCard>): ReactNode => (
  <CardFrame card={card} {...(columns === undefined ? {} : { columns })} />
);

/** The handoff card (CAP-23): a colleague's note, pointing at the document and the branch. */
export const HandoffCardView = ({ card, columns }: CardProps<HandoffCard>): ReactNode => (
  <CardFrame card={card} {...(columns === undefined ? {} : { columns })} />
);

/**
 * Draw whichever card was built.
 *
 * The switch is total over `Card['kind']`, so a seventh surface is a compile error here rather than a card
 * that silently draws nothing — the same reason the control table and the mode table are total maps.
 */
export const CardView = ({ card, columns }: CardProps<Card>): ReactNode => {
  const width = columns === undefined ? {} : { columns };
  switch (card.kind) {
    case 'question':
      return <QuestionCardView card={card} {...width} />;
    case 'spec-echo':
      return <SpecEchoCardView card={card} {...width} />;
    case 'brief':
      return <BriefCardView card={card} {...width} />;
    case 'kill':
      return <KillCardView card={card} {...width} />;
    case 'completion':
      return <CompletionCardView card={card} {...width} />;
    case 'handoff':
      return <HandoffCardView card={card} {...width} />;
  }
};
