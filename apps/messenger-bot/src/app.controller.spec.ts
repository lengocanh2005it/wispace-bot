import { AppController } from './app.controller';

describe('AppController', () => {
  it('should return API status text', () => {
    const appController = new AppController();
    expect(appController.getHello()).toBe(
      'Messenger AI Notification API is running',
    );
  });
});
