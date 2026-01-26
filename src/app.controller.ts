import { Controller, Get } from '@nestjs/common';

@Controller('/')
export class AppController {
  @Get()
  getHello(): string {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Roblox Events Receiver</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div>
    <h1>Roblox Events Receiver</h1>
    <p>
      Lightweight backend service for receiving, validating, and processing
      real-time Roblox game events.
    </p>

    <p>Status: <strong>Online</strong></p>

    <section>
      <h2>📡 Service Overview</h2>
      <p>
        This API listens for events sent from Roblox servers via HttpService, 
        validates the incoming data, and forwards it to internal systems such as
        databases, analytics pipelines, or dashboards.
      </p>
    </section>

    <section>
      <h2>🚀 Usage Notes</h2>
      <ul>
        <li>Secure your webhook endpoints with validation keys.</li>
        <li>Handle events asynchronously to avoid blocking.</li>
        <li>Log errors for monitoring and debugging purposes.</li>
      </ul>
    </section>

    <footer>
      Built for Roblox integrations • v2
    </footer>
  </div>
</body>
</html>
    `;
  }
}
