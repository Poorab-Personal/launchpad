import React from 'react';
import { hubspot, Text, Flex, Tile } from '@hubspot/ui-extensions';

hubspot.extend(() => <Deprecated />);

function Deprecated() {
  return (
    <Tile>
      <Flex direction="column" gap="small">
        <Text format={{ fontWeight: 'bold' }}>
          ⚠ This card is deprecated.
        </Text>
        <Text variant="microcopy">
          Replaced by "Rejig — Customer Dashboard" (a single unified card
          visible on both Contact and Ticket records). Please remove this
          card from your record layout via Settings → Objects → Tickets
          → Customize Record Layout.
        </Text>
      </Flex>
    </Tile>
  );
}
