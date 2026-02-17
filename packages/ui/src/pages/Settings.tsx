import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function Settings() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Server Configuration</CardTitle>
          <CardDescription>
            These settings are read from untangle.yaml. Edit the config file to change them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="port">Port</Label>
            <Input id="port" type="number" defaultValue={3000} disabled className="max-w-xs" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="host">Host</Label>
            <Input id="host" type="text" defaultValue="localhost" disabled className="max-w-xs" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
