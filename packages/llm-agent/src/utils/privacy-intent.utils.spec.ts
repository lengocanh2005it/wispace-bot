import {
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
} from './privacy-intent.utils';

describe('detectPrivacyIntent', () => {
  describe('unlink intent', () => {
    it.each([
      'ngắt kết nối',
      'hủy liên kết',
      'huỷ liên kết',
      'unlink',
      'disconnect',
      'ngưng dùng',
      'stop using',
    ])('detects "%s" as unlink', (text) => {
      expect(detectPrivacyIntent(text)).toBe('unlink');
    });
  });

  describe('delete intent', () => {
    it.each([
      'xóa tài khoản',
      'xóa data',
      'xóa dữ liệu',
      'xóa toàn bộ',
      'delete account',
      'delete data',
      'xoá tài khoản',
      'erasure',
      'right to be forgotten',
    ])('detects "%s" as delete', (text) => {
      expect(detectPrivacyIntent(text)).toBe('delete');
    });
  });

  describe('export intent', () => {
    it.each([
      'tải về',
      'tải dữ liệu',
      'export data',
      'export account',
      'download data',
      'download my data',
      'right to portability',
      'trích xuất',
    ])('detects "%s" as export', (text) => {
      expect(detectPrivacyIntent(text)).toBe('export');
    });
  });

  describe('non-privacy intents', () => {
    it.each([
      'xem lịch học',
      'đăng ký nhận báo cáo',
      'band hiện tại của mình',
      'hello',
      'cảm ơn',
    ])('returns null for "%s"', (text) => {
      expect(detectPrivacyIntent(text)).toBeNull();
    });
  });

  describe('case insensitivity', () => {
    it('handles uppercase', () => {
      expect(detectPrivacyIntent('UNLINK')).toBe('unlink');
    });

    it('handles mixed case', () => {
      expect(detectPrivacyIntent('Ngắt Kết Nối')).toBe('unlink');
    });
  });
});

describe('isConfirmationResponse', () => {
  it.each([
    'có',
    'yes',
    'ok',
    'oke',
    'okay',
    'đồng ý',
    'chắc chắn',
    'confirm',
    'y',
  ])('accepts "%s"', (text) => {
    expect(isConfirmationResponse(text)).toBe(true);
  });

  it.each(['không', 'no', 'cancel', 'hủy', 'bỏ'])('rejects "%s"', (text) => {
    expect(isConfirmationResponse(text)).toBe(false);
  });
});

describe('isCancellationResponse', () => {
  it.each(['không', 'no', 'cancel', 'hủy', 'huỷ', 'bỏ', 'thoát', 'exit', 'n'])(
    'accepts "%s"',
    (text) => {
      expect(isCancellationResponse(text)).toBe(true);
    },
  );

  it.each(['có', 'yes', 'ok', 'đồng ý'])('rejects "%s"', (text) => {
    expect(isCancellationResponse(text)).toBe(false);
  });
});
