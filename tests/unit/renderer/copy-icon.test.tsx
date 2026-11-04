// @vitest-environment jsdom
import { mock, ui } from './helpers';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CopyIconButton } from '../../../src/renderer/src/components/ui/CopyIconButton';

describe('CopyIconButton', () => {
  it('has a field-specific name, no visible text, and copies through the main-process path', async () => {
    const ctl = mock();
    const user = userEvent.setup();
    ui(<CopyIconButton text="XX0000001" label="passport" />);
    const btn = screen.getByRole('button', { name: 'Copy passport' });
    expect(btn).toHaveTextContent('');
    expect(btn.querySelector('svg')).not.toBeNull();
    await user.click(btn);
    await waitFor(() => expect(ctl.db.clipboard).toBe('XX0000001'));
  });

  it('swaps to a checkmark with a polite announcement, then back', async () => {
    mock();
    const user = userEvent.setup();
    ui(<CopyIconButton text="abc" label="name" />);
    const btn = screen.getByRole('button', { name: 'Copy name' });
    await user.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute('data-copied', 'true'));
    expect(screen.getByText('Copied', { selector: '[aria-live="polite"]' })).toBeInTheDocument();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1400));
    });
    expect(btn).not.toHaveAttribute('data-copied');
  });

  it('renders nothing for an empty value', () => {
    mock();
    ui(<CopyIconButton text="" label="name" />);
    expect(screen.queryByRole('button', { name: /Copy/ })).toBeNull();
  });
});
