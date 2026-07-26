from pathlib import Path

from PIL import Image, ImageDraw

assets = Path(
    r'C:\Users\reallexx\.cursor\projects\d-Other-kino-pub-improve\assets'
)
out_dir = Path(__file__).resolve().parents[1] / 'docs' / 'screenshots'
out_dir.mkdir(parents=True, exist_ok=True)

sources = [
    ('image-5a028dcf-a902-4320-82a3-751ce3eee500.png', 'popup.png', []),
    ('image-4d03a68d-1ab2-4964-88a1-ca8cf01ae55b.png', 'popup-myshows.png', []),
    (
        'image-1bd3f4b1-58ae-4c75-b72f-e75c540e4b31.png',
        'list-watched.png',
        [
            # профиль + дни подписки
            (880, 2, 1022, 58),
            # бейдж счётчика «Я смотрю»
            (155, 200, 210, 235),
        ],
    ),
    (
        'image-51efb481-e0f3-440f-aa5a-ec37aee4ea3b.png',
        'search-watched.png',
        [
            (880, 2, 1022, 58),
            (155, 200, 210, 235),
        ],
    ),
    ('image-00528f06-9a6f-44ee-8e3b-ef56f8bbda53.png', 'report.png', []),
    ('image-98c79101-f88d-49a2-8eb9-9d771e025c85.png', 'options.png', []),
]


def redact_boxes(image, boxes, fill=(28, 30, 36)):
    result = image.convert('RGB')
    draw = ImageDraw.Draw(result)
    for left, top, right, bottom in boxes:
        draw.rectangle((left, top, right, bottom), fill=fill)
    return result


for source_name, dest_name, boxes in sources:
    matches = list(assets.glob(f'*{source_name}'))
    if not matches:
        raise SystemExit(f'missing {source_name}')
    source_path = matches[0]
    image = Image.open(source_path).convert('RGB')
    if boxes:
        image = redact_boxes(image, boxes)
    dest_path = out_dir / dest_name
    image.save(dest_path, format='PNG', optimize=True)
    print(f'{dest_name}: {image.size} <- {source_path.name}')

print('done')
