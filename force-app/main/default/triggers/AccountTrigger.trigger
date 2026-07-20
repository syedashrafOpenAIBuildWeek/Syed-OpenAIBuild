trigger AccountTrigger on Account (before insert) {
    for (Account acc : Trigger.new) {
        acc.TickerSymbol = 'Ticker';
        acc.Account_Check__c = true;
    }
}