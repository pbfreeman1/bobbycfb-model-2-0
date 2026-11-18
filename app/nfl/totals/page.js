import { redirect } from 'next/navigation';

// The O/U board now lives on the dashboard's O/U tab. The previous board is at /nfl/legacy/totals.
export default function NflTotals() {
  redirect('/nfl/dashboard?m=total');
}
