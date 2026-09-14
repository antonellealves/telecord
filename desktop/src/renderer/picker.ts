/// <reference lib="dom" />

interface PickerSource {
  id: string;
  name: string;
  thumbnail: string;
  isScreen: boolean;
}

interface PickerBridge {
  list: () => Promise<PickerSource[]>;
  choose: (id: string) => void;
  cancel: () => void;
}

declare global {
  interface Window {
    picker: PickerBridge;
  }
}

export {};

async function main(): Promise<void> {
  const grid = document.getElementById('grid');
  const cancelButton = document.getElementById('cancel');
  if (grid === null || cancelButton === null) return;

  const sources = await window.picker.list();

  for (const source of sources) {
    const item = document.createElement('div');
    item.className = 'item';

    const img = document.createElement('img');
    img.src = source.thumbnail;
    img.alt = source.name;

    const label = document.createElement('span');
    label.textContent = source.isScreen ? `Tela: ${source.name}` : source.name;

    item.appendChild(img);
    item.appendChild(label);
    item.addEventListener('click', () => window.picker.choose(source.id));
    grid.appendChild(item);
  }

  cancelButton.addEventListener('click', () => window.picker.cancel());
}

void main();
