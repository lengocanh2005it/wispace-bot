import {
  detectPrivacyIntent,
  isConfirmationResponse,
  isCancellationResponse,
  type PrivacyAction,
} from './privacy-intent.utils';

describe('detectPrivacyIntent', () => {
  describe('unlink intent', () => {
    it.each([
      'ngắt kết nối',
      'hủy liên kết',
      'huỷ liên kết',
      'unlink',
      'disconnect',
      'disconnect my account',
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
      'trích xuất',
      'tải data',
      'trích xuất dữ liệu',
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
      'Xóa tài khoản thì có mất lịch học không ạ?',
      'Làm sao để KHÔNG bị xóa dữ liệu vậy bạn',
      'bạn đừng hủy liên kết của mình nhé',
      'Task 2: Some people believe governments should delete data collected from citizens after five years. Discuss.',
      'In my opinion, the right to be forgotten is essential in the digital age.',
      'Nowadays people can easily unlink their accounts from social media platforms.',
      'erasure',
      'right to be forgotten',
      'right to portability',
    ])('returns null for "%s"', (text) => {
      expect(detectPrivacyIntent(text)).toBeNull();
    });
  });

  describe('explicit request shape', () => {
    it.each([
      ['xoa tai khoan', 'delete'],
      ['mình muốn xóa dữ liệu nhé', 'delete'],
      ['please delete data', 'delete'],
      ['tôi muốn ngắt kết nối', 'unlink'],
      ['cho mình tải dữ liệu', 'export'],
      ['disconnect my account', 'unlink'],
      ['xóa dữ liệu ngay', 'delete'],
      ['delete data please', 'delete'],
      ['xóa dữ liệu ạ', 'delete'],
      ['giúp mình xóa dữ liệu', 'delete'],
      ['xóa toàn bộ dữ liệu của tôi', 'delete'],
    ])('detects only an explicit request: "%s"', (text, intent) => {
      expect(detectPrivacyIntent(text)).toBe(intent);
    });

    it.each([
      'xóa dữ liệu?',
      'xóa tài khoản？',
      'xóa dữ liệu à',
      'xóa dữ liệu a',
      'xóa dữ liệu a!',
      'xóa dữ liệu a\u0300',
      'xóa dữ liệu 🤔',
      'xóa dữ liệu⁉',
      'xóa dữ liệu à。',
      'xóa dữ liệu 🙂 !',
      'xóa dữ liệu # .',
    ])('does not arm an interrogative request: "%s"', (text) => {
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

    it('accepts decomposed Vietnamese text after NFC normalization', () => {
      expect(detectPrivacyIntent('xóa dữ liệu ạ'.normalize('NFD'))).toBe(
        'delete',
      );
    });
  });

  it('rejects long padding before normalization', () => {
    expect(detectPrivacyIntent(`xóa dữ liệu${' '.repeat(80)}`)).toBeNull();
  });

  it.each(['xóa\u000b dữ liệu', 'xóa dữ liệu\uFEFF'])(
    'rejects hidden control characters: "%s"',
    (text) => {
      expect(detectPrivacyIntent(text)).toBeNull();
    },
  );
});

describe('isConfirmationResponse', () => {
  const deliberateConfirmations: Array<[string, PrivacyAction]> = [
    ['đồng ý ngắt kết nối', 'unlink'],
    ['dong y ngat ket noi nhe!', 'unlink'],
    ['xác nhận xóa dữ liệu.', 'delete'],
    ['dong y xoa toan bo du lieu nha', 'delete'],
    ['đồng ý xóa dữ liệu ạ', 'delete'],
    ['confirm delete', 'delete'],
    ['đồng ý tải dữ liệu', 'export'],
  ];

  it.each(deliberateConfirmations)(
    'accepts deliberate "%s" for %s',
    (text, intent) => {
      expect(isConfirmationResponse(text, intent)).toBe(true);
    },
  );

  it.each([
    'ok',
    'có',
    'y',
    'vâng',
    'ừ',
    'co',
    'dong y',
    'ok nhé',
    'có nhé',
    'Có.',
    'OK!',
    'đúng rồi',
    'đồng ý xóa dữ liệu?',
    'đồng ý xóa dữ liệu à',
    'đồng ý xóa dữ liệu a',
    'đồng ý xóa dữ liệu a\u0300',
    'đồng ý xóa dữ liệu 🤔',
    'đồng ý xóa dữ liệu à。',
    'đồng ý xóa dữ liệu 🙂 !',
  ])('rejects ambiguous "%s" for delete', (text) => {
    expect(isConfirmationResponse(text, 'delete')).toBe(false);
  });
});

describe('isCancellationResponse', () => {
  it.each([
    'không',
    'khong nhe',
    'no.',
    'cancel!',
    'hủy nhé',
    'huỷ',
    'bỏ nha',
    'thoát',
    'exit',
    'n',
  ])('accepts "%s"', (text) => {
    expect(isCancellationResponse(text)).toBe(true);
  });

  it.each([
    'có',
    'yes',
    'ok',
    'đồng ý',
    'đồng ý xóa dữ liệu',
    'không?',
    'không à',
    'không 🤔',
  ])('rejects "%s"', (text) => {
    expect(isCancellationResponse(text)).toBe(false);
  });

  it('accepts decomposed Vietnamese cancellation text', () => {
    expect(isCancellationResponse('bỏ'.normalize('NFD'))).toBe(true);
  });
});
