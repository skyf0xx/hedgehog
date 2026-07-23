import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';

export default function Index() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Hedgehog</h1>
        <ThemeToggle />
      </div>
      <Button>Get started</Button>
    </div>
  );
}
