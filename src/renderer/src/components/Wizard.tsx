/**
 * Shared shell for multi-step import wizards (docs/PLAN-ALPHA.md section 8, lane F, R5).
 *
 * The wizard owns the step header, the Back / Cancel / Next footer and the discard confirmation. The screen owns
 * the data: it keeps every entered value in its own state, so Back never loses anything, and it decides what
 * Cancel does (drop the preview, navigate away). `dirty` says whether leaving would throw work away.
 *
 * Keyboard: Escape acts as Cancel when focus is inside the wizard (an open dropdown closes first; dialogs opened
 * from the wizard handle their own Escape). The step heading takes focus when the step changes.
 */
import { Button, Group, Modal, Stack, Text, Title } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface WizardStep {
  id: string;
  label: string;
}

/** "Discard this work?" confirmation. "Keep editing" is the default (focused) choice. */
export function DiscardDialog({
  opened,
  onKeep,
  onDiscard,
}: {
  opened: boolean;
  onKeep: () => void;
  onDiscard: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal opened={opened} onClose={onKeep} title={t('wizard.discardTitle')} size="sm" trapFocus returnFocus>
      <Text size="sm">{t('wizard.discardBody')}</Text>
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onKeep} data-autofocus>
          {t('wizard.keepEditing')}
        </Button>
        <Button color="red" onClick={onDiscard}>
          {t('wizard.discard')}
        </Button>
      </Group>
    </Modal>
  );
}

export interface WizardProps {
  steps: readonly WizardStep[];
  /** Index into `steps` of the step on screen. */
  current: number;
  /** null disables Back (first step). */
  onBack: (() => void) | null;
  /** Next, or the final action on the last step. */
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  /** Why Next is disabled, shown next to it (a disabled button never stays silent, UI review O-10). */
  nextHint?: string | null;
  nextLoading?: boolean;
  /** True when cancelling would discard entered work; Cancel and Escape then ask first. */
  dirty: boolean;
  /** Runs after Cancel (and, when dirty, after the discard is confirmed). The screen drops its data here. */
  onCancel: () => void;
  children: ReactNode;
}

export function Wizard({
  steps,
  current,
  onBack,
  onNext,
  nextLabel,
  nextDisabled = false,
  nextHint = null,
  nextLoading = false,
  dirty,
  onCancel,
  children,
}: WizardProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [confirming, setConfirming] = useState(false);
  const shownOnce = useRef(false);

  // Move focus to the step heading on every step change (not on the first render).
  useEffect(() => {
    if (!shownOnce.current) {
      shownOnce.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [current]);

  const requestCancel = () => (dirty ? setConfirming(true) : onCancel());

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    // Events from a dialog opened by the wizard bubble through React portals; that dialog handles its own Escape.
    if (!rootRef.current?.contains(target)) return;
    // An open dropdown (combobox) closes first.
    if (target.getAttribute('aria-expanded') === 'true') return;
    e.preventDefault();
    requestCancel();
  };

  const step = steps[current];
  return (
    <Stack ref={rootRef} gap="md" onKeyDown={onKeyDown} data-testid="wizard">
      <ol
        aria-label={t('wizard.stepsLabel')}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 16, listStyle: 'none', margin: 0, padding: 0 }}
      >
        {steps.map((s, i) => (
          <li
            key={s.id}
            aria-current={i === current ? 'step' : undefined}
            style={{ fontWeight: i === current ? 700 : 400 }}
          >
            {i + 1}. {s.label}
          </li>
        ))}
      </ol>
      {step && (
        <div>
          <Text size="sm" c="dimmed">
            {t('wizard.stepOf', { n: current + 1, total: steps.length })}
          </Text>
          <Title order={2} size="h3" ref={headingRef} tabIndex={-1}>
            {step.label}
          </Title>
        </div>
      )}
      {children}
      <Group justify="space-between" mt="md">
        <Button variant="default" onClick={onBack ?? undefined} disabled={!onBack}>
          {t('wizard.back')}
        </Button>
        <Group gap="sm">
          {nextDisabled && nextHint && (
            <Text size="sm" id="wizard-next-hint" data-testid="wizard-next-hint">
              {nextHint}
            </Text>
          )}
          <Button variant="subtle" color="gray" onClick={requestCancel}>
            {t('wizard.cancel')}
          </Button>
          <Button
            onClick={onNext}
            disabled={nextDisabled}
            loading={nextLoading}
            aria-describedby={nextDisabled && nextHint ? 'wizard-next-hint' : undefined}
          >
            {nextLabel}
          </Button>
        </Group>
      </Group>
      <DiscardDialog
        opened={confirming}
        onKeep={() => setConfirming(false)}
        onDiscard={() => {
          setConfirming(false);
          onCancel();
        }}
      />
    </Stack>
  );
}
