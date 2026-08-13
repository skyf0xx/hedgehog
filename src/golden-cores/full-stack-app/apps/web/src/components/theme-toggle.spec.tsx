import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from './theme-toggle';

describe('ThemeToggle', () => {
  it('renders a toggle button and flips the document theme class on click', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = screen.getByRole('button', { name: /toggle theme/i });
    expect(toggle).toBeInTheDocument();

    await user.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    await user.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
