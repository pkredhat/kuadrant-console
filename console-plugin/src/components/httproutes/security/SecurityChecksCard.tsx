import * as React from 'react';
import {
  Card,
  CardTitle,
  CardBody,
  Button,
  Flex,
  FlexItem,
  Icon,
} from '@patternfly/react-core';
import { RedoIcon } from '@patternfly/react-icons';
import { Table, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';
import { SecurityCheck } from './routeSecurityTypes';
import { CheckStatusLabel } from './SecurityAtoms';

interface Props {
  checks: SecurityCheck[];
  onReRun: () => void;
}

/**
 * Automated security-checks table. The `re-run` button re-triggers the
 * header probe (the only network-side check) — everything else is derived
 * from cluster state and refreshes with the underlying watches.
 */
export const SecurityChecksCard: React.FC<Props> = ({ checks, onReRun }) => {
  return (
    <Card>
      <CardTitle>
        <Flex justifyContent={{ default: 'justifyContentSpaceBetween' }} alignItems={{ default: 'alignItemsCenter' }}>
          <FlexItem>Security Checks</FlexItem>
          <FlexItem>
            <Button variant="link" isInline onClick={onReRun} icon={<Icon><RedoIcon /></Icon>}>
              Re-run checks
            </Button>
          </FlexItem>
        </Flex>
      </CardTitle>
      <CardBody>
        <Table aria-label="Security checks" variant="compact">
          <Thead>
            <Tr>
              <Th>Check</Th>
              <Th>Status</Th>
              <Th>Details</Th>
            </Tr>
          </Thead>
          <Tbody>
            {checks.map((c) => (
              <Tr key={c.id}>
                <Td>{c.label}</Td>
                <Td>
                  <CheckStatusLabel status={c.status} />
                </Td>
                <Td>{c.details}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </CardBody>
    </Card>
  );
};
