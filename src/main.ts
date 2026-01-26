import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ✅ Enable class-validator globally
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,              // strips unknown properties
      forbidNonWhitelisted: true,   // throws error on extra fields
      transform: true,              // auto-transform DTOs
    }),
  );

  await app.listen(process.env.PORT ?? 3000).then(() => {
    console.log(`🚀 Server running on http://localhost:${process.env.PORT ?? 3000}`);
  });
}
bootstrap();
