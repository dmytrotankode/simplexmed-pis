import { Modal, type ModalProps } from 'react-native';

import { isModalAllowed } from '../lib/lock';
import { useSession } from '../lib/session';
import { PrivacyCover } from './LockOverlay';

/**
 * Модальне вікно кабінету (п.2.9 ТВ ПІС). RN <Modal> — окреме нативне вікно поверх застосунку, тож екран
 * блокування і заставка перемикача застосунків його не перекривають. Тому вікно показується лише в
 * розблокованому кабінеті (після блокування воно ховається і повертається після розблокування з тим самим
 * вмістом), а коли застосунок неактивний — вміст закриває заставка.
 * allowSignedOut — для форми реєстрації до входу (PIN-коду ще немає).
 */
export function SecureModal({ visible, allowSignedOut = false, children, ...props }: ModalProps & { allowSignedOut?: boolean }) {
  const { status, appState } = useSession();
  const shown = Boolean(visible) && isModalAllowed(status, allowSignedOut);
  return (
    <Modal visible={shown} {...props}>
      {children}
      {shown && appState !== 'active' ? <PrivacyCover /> : null}
    </Modal>
  );
}
