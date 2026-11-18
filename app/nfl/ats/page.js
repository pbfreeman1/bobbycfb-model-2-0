import { redirect } from 'next/navigation';

// The ATS board now lives on the dashboard's ATS tab. The previous board is at /nfl/legacy/ats.
export default function NflAts() {
  redirect('/nfl/dashboard?m=spread');
}
